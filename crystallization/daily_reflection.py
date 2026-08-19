#!/usr/bin/env python3
"""
每日反思 v2 - 举一反三 + 过时结晶更新

触发方式：cron 每日凌晨 02:30 执行

核心能力：
1. 举一反三：翻阅最近 7 天的交互，跨天归纳同类问题
2. 过时检测：对比已有结晶模式与最新解决路径，检测是否需要更新
3. 批量分析：当天交互 + 7 天窗口内的跨日聚合
4. 自动升降级 + 过时标记

流程：
1. 查询当天 + 最近 7 天的 interactions
2. 批量分析解决路径
3. 跨天聚合：同一泛化模式在不同日期出现的次数
4. 更新 solution_patterns（累加计数、升降级）
5. 过时检测：已有结晶的 solution_path 与最新路径对比
6. 输出反思报告
"""

import json
import sqlite3
import sys
import os
import hashlib
from datetime import datetime, timedelta
from collections import defaultdict

sys.path.insert(0, "/root/crystallization")
from reflection_engine import (
    ensure_tables, analyze_solution_path, record_pattern,
    promote_or_demote, extract_pattern_hash, get_active_patterns
)

DB_PATH = "/root/crystallization/crystallization.db"
REFLECTION_WINDOW_DAYS = 7


def _extract_solution_signature(output_text: str, analysis: dict) -> str:
    """
    提取解决路径的"签名"——用于检测路径是否过时。
    签名是对解决方法的关键特征做哈希，而非对具体参数值。
    """
    text = output_text or ""
    # 提取关键动作特征
    features = []
    
    # SSH 目标
    import re
    ssh_matches = re.findall(r'ssh.*?@(\d+\.\d+\.\d+\.\d+)', text)
    if ssh_matches:
        features.append(f"ssh:{ssh_matches[0]}")
    
    # Docker 命令类型
    docker_matches = re.findall(r'docker\s+(\w+)', text)
    if docker_matches:
        features.append(f"docker:{','.join(sorted(set(docker_matches)))}")
    
    # API 端点
    api_matches = re.findall(r'(?:curl|requests)\w*.*?(https?://[^\s\'"]+)', text)
    if api_matches:
        # 只取域名，忽略路径参数
        from urllib.parse import urlparse
        domains = sorted(set(urlparse(u).netloc for u in api_matches))
        features.append(f"api:{','.join(domains)}")
    
    # 错误码
    error_matches = re.findall(r'(?:errcode|error|HTTP)["\s:]*(\d{3})', text, re.I)
    if error_matches:
        features.append(f"error:{','.join(sorted(set(error_matches)))}")
    
    # 关键操作动词
    verbs = []
    if re.search(r'restart|重启', text, re.I): verbs.append("restart")
    if re.search(r'switch|切换|切到', text, re.I): verbs.append("switch")
    if re.search(r'upload|上传', text, re.I): verbs.append("upload")
    if re.search(r'embed|嵌入|向量化', text, re.I): verbs.append("embed")
    if re.search(r'config|配置|env', text, re.I): verbs.append("config")
    if re.search(r'install|安装|pip', text, re.I): verbs.append("install")
    if verbs:
        features.append(f"verbs:{','.join(sorted(verbs))}")
    
    # 分析类型
    features.append(f"type:{analysis.get('path_type', 'unknown')}")
    if analysis.get("generalized_pattern"):
        features.append(f"pattern:{analysis['generalized_pattern']}")
    
    signature = hashlib.md5("|".join(features).encode()).hexdigest()[:12]
    return signature


def _detect_stale_patterns(conn) -> list:
    """
    检测已有结晶模式是否过时。
    
    过时判定：
    - 同一 pattern_name 下，最近 3 次交互的 solution_signature 与已存储的不同
    - 说明解决路径发生了变化，旧的结晶需要更新
    
    返回需要更新的模式列表。
    """
    c = conn.cursor()
    
    # 获取所有有 module 的活跃模式（stage >= 2）
    c.execute("""
        SELECT pattern_hash, pattern_name, generalized_pattern, stage, 
               solution_path, module_path, last_stage_change
        FROM solution_patterns 
        WHERE stage >= 1 AND crystallizable = 1
    """)
    active_patterns = c.fetchall()
    
    stale = []
    for row in active_patterns:
        pat_hash, pat_name, gname, stage, stored_path, module_path, last_change = row
        
        # 查最近 3 次关联的交互
        c.execute("""
            SELECT i.input_text, i.output_text 
            FROM reflection_log r
            JOIN interactions i ON r.interaction_id = i.id
            WHERE r.pattern_hash = ?
            ORDER BY i.id DESC
            LIMIT 3
        """, (pat_hash,))
        recent = c.fetchall()
        
        if len(recent) < 2:
            continue
        
        # 计算最近交互的签名
        recent_sigs = set()
        for inp, outp in recent:
            analysis = analyze_solution_path(outp)
            sig = _extract_solution_signature(outp, analysis)
            recent_sigs.add(sig)
        
        # 计算已存储路径的签名
        try:
            stored_analysis = json.loads(stored_path) if stored_path else {}
        except (json.JSONDecodeError, TypeError):
            stored_analysis = {}
        # stored_path 可能是 list（旧格式）或 dict（新格式）
        if isinstance(stored_analysis, list):
            stored_analysis = {"detected_types": stored_analysis, "path_type": "unknown"}
        if not isinstance(stored_analysis, dict):
            stored_analysis = {}
        stored_sig = _extract_solution_signature(
            json.dumps(stored_analysis, ensure_ascii=False) if stored_analysis else "",
            stored_analysis
        )
        
        # 如果最近 3 次的签名一致，但与存储的不同 -> 路径已变化
        if len(recent_sigs) == 1 and stored_sig and list(recent_sigs)[0] != stored_sig:
            stale.append({
                "pattern_hash": pat_hash,
                "pattern_name": pat_name or gname or "unknown",
                "stage": stage,
                "old_signature": stored_sig,
                "new_signature": list(recent_sigs)[0],
                "recent_count": len(recent),
                "action": "needs_update",
            })
        
        # 如果最近 3 次签名不一致 -> 路径不稳定，可能需要降级
        elif len(recent_sigs) > 2:
            stale.append({
                "pattern_hash": pat_hash,
                "pattern_name": pat_name or gname or "unknown",
                "stage": stage,
                "old_signature": stored_sig,
                "new_signatures": list(recent_sigs),
                "recent_count": len(recent),
                "action": "unstable_path",
            })
    
    return stale


def _update_stale_pattern(conn, pattern_hash: str, latest_output: str, analysis: dict):
    """更新过时模式的 solution_path。"""
    new_sig = _extract_solution_signature(latest_output, analysis)
    new_path = json.dumps({
        "detected_types": analysis.get("detected_types", []),
        "path_type": analysis.get("path_type"),
        "signature": new_sig,
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }, ensure_ascii=False)
    
    c = conn.cursor()
    c.execute("""
        UPDATE solution_patterns 
        SET solution_path = ?, 
            confidence = MAX(confidence, 0.7),
            last_stage_change = datetime('now', 'localtime')
        WHERE pattern_hash = ?
    """, (new_path, pattern_hash))
    conn.commit()


def _cross_day_aggregate(rows: list, window_start: str, target_date: str) -> dict:
    """
    举一反三：跨天归纳同类问题。
    
    返回:
    {
        "target_date_patterns": {pattern: [items]},  # 当天的
        "window_patterns": {pattern: [items]},        # 7天窗口内的
        "cross_day_patterns": {pattern: {"days": [dates], "total": N}},  # 跨天出现的
        "new_cross_day": [patterns],  # 当天新出现的跨天模式
    }
    """
    target_groups = defaultdict(list)
    window_groups = defaultdict(list)
    
    for row in rows:
        iid, inp, outp, otype, sid, ts = row
        analysis = analyze_solution_path(outp)
        gname = analysis.get("generalized_pattern") or "uncategorized"
        
        item = {
            "interaction_id": iid,
            "input": inp[:60],
            "output_type": otype,
            "analysis": analysis,
            "date": ts[:10] if ts else target_date,
            "output_text": outp,
        }
        
        window_groups[gname].append(item)
        if ts and ts[:10] == target_date:
            target_groups[gname].append(item)
    
    # 跨天聚合
    cross_day = {}
    for gname, items in window_groups.items():
        days = sorted(set(item["date"] for item in items))
        if len(days) >= 2:
            cross_day[gname] = {
                "days": days,
                "total": len(items),
                "target_date_count": len(target_groups.get(gname, [])),
            }
    
    # 当天新出现的跨天模式（之前没有但今天出现了）
    new_cross_day = []
    for gname, info in cross_day.items():
        if info["target_date_count"] > 0:
            new_cross_day.append(gname)
    
    return {
        "target_date_patterns": dict(target_groups),
        "window_patterns": dict(window_groups),
        "cross_day_patterns": cross_day,
        "new_cross_day": new_cross_day,
    }


def run_daily_reflection(target_date: str = None) -> dict:
    """
    对指定日期的所有交互进行批量反思，含 7 天跨日归纳。
    """
    ensure_tables()
    
    if not target_date:
        target_date = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    
    window_start = (datetime.strptime(target_date, "%Y-%m-%d") - 
                    timedelta(days=REFLECTION_WINDOW_DAYS - 1)).strftime("%Y-%m-%d")
    
    # 1. 查询 7 天窗口内所有交互
    conn = sqlite3.connect(DB_PATH, timeout=5)
    c = conn.cursor()
    c.execute("""
        SELECT id, input_text, output_text, output_type, session_id, timestamp
        FROM interactions
        WHERE date(timestamp) >= ? AND date(timestamp) <= ?
        ORDER BY id
    """, (window_start, target_date))
    window_rows = c.fetchall()
    
    # 当天交互
    target_rows = [r for r in window_rows if r[5] and r[5][:10] == target_date]
    
    if not target_rows:
        conn.close()
        return {
            "date": target_date,
            "total_interactions": 0,
            "message": "当天无交互数据",
        }
    
    # 2. 举一反三：跨天归纳
    aggregation = _cross_day_aggregate(window_rows, window_start, target_date)
    
    # 3. 对当天交互逐条分析并记录
    pattern_updates = []
    target_analyses = []
    
    for row in target_rows:
        iid, inp, outp, otype, sid, ts = row
        analysis = analyze_solution_path(outp)
        target_analyses.append({
            "interaction_id": iid,
            "input": inp[:60],
            "analysis": analysis,
            "output_text": outp,
        })
        
        result = record_pattern(
            analysis=analysis,
            input_text=inp,
            interaction_id=iid,
        )
        pattern_updates.append({
            "pattern": analysis.get("generalized_pattern") or "uncategorized",
            "interaction_id": iid,
            "action": result["action"],
            "stage": result["stage"],
            "count": result["occurrence_count"],
        })
    
    # 4. 过时检测
    stale_patterns = _detect_stale_patterns(conn)
    
    # 自动更新过时模式
    stale_updates = []
    for stale in stale_patterns:
        if stale["action"] == "needs_update":
            # 找到最新的交互输出
            c.execute("""
                SELECT i.output_text FROM reflection_log r
                JOIN interactions i ON r.interaction_id = i.id
                WHERE r.pattern_hash = ?
                ORDER BY i.id DESC LIMIT 1
            """, (stale["pattern_hash"],))
            row = c.fetchone()
            if row:
                analysis = analyze_solution_path(row[0])
                _update_stale_pattern(conn, stale["pattern_hash"], row[0], analysis)
                stale_updates.append({
                    "pattern": stale["pattern_name"],
                    "action": "solution_path_updated",
                    "old_sig": stale["old_signature"],
                    "new_sig": stale["new_signature"],
                })
        elif stale["action"] == "unstable_path":
            # 路径不稳定，降级
            c.execute("""
                UPDATE solution_patterns 
                SET stage = MAX(stage - 1, 0),
                    last_stage_change = datetime('now', 'localtime')
                WHERE pattern_hash = ?
            """, (stale["pattern_hash"],))
            conn.commit()
            stale_updates.append({
                "pattern": stale["pattern_name"],
                "action": "demoted_unstable",
                "old_stage": stale["stage"],
                "new_stage": stale["stage"] - 1,
            })
    
    # 5. 对所有 shadow+ 模式执行升降级检查
    active = get_active_patterns()
    promotions = []
    for pat in active:
        result = promote_or_demote(pat["pattern_hash"])
        if result["action"] != "no_change":
            promotions.append({
                "pattern": pat["pattern_name"],
                "action": result["action"],
                "old_stage": result.get("old_stage"),
                "new_stage": result.get("new_stage"),
            })
    
    conn.close()
    
    # 6. 生成报告
    total = len(target_rows)
    crystallizable = sum(1 for a in target_analyses if a["analysis"]["crystallizable"])
    reasoning_only = total - crystallizable
    
    cross_day = aggregation["cross_day_patterns"]
    report = {
        "date": target_date,
        "window": f"{window_start} ~ {target_date}",
        "window_interactions": len(window_rows),
        "total_interactions": total,
        "crystallizable": crystallizable,
        "reasoning_only": reasoning_only,
        "unique_patterns": len(aggregation["target_date_patterns"]),
        "pattern_breakdown": {
            gname: len(items) for gname, items in aggregation["target_date_patterns"].items()
        },
        "cross_day_patterns": cross_day,
        "stage_changes": promotions,
        "stale_updates": stale_updates,
        "current_active_patterns": len(active),
        "messages": [],
    }
    
    # 人类可读消息
    report["messages"].append(
        f"📊 {target_date} 反思报告"
    )
    report["messages"].append(
        f"  窗口: {window_start} ~ {target_date}（{len(window_rows)} 条交互）"
    )
    report["messages"].append(
        f"  当天: {total} 条，{crystallizable} 可结晶，{reasoning_only} 纯推理，"
        f"{len(aggregation['target_date_patterns'])} 个模式"
    )
    
    # 跨日归纳
    if cross_day:
        report["messages"].append(f"  🔄 跨日归纳（{len(cross_day)} 个模式在多天出现）:")
        for gname, info in sorted(cross_day.items(), key=lambda x: -x[1]["total"]):
            days_str = "→".join(info["days"][-3:])  # 最多显示最近3天
            report["messages"].append(
                f"    • {gname}: {info['total']} 次，跨 {len(info['days'])} 天 ({days_str})"
            )
    
    # 当天模式
    if report["pattern_breakdown"]:
        report["messages"].append(f"  📋 当天模式分布:")
        for gname, count in sorted(report["pattern_breakdown"].items(), key=lambda x: -x[1]):
            report["messages"].append(f"    • {gname}: {count} 次")
    
    # 阶段变更
    if promotions:
        report["messages"].append(f"  ⚡ 阶段变更:")
        for p in promotions:
            action_cn = {
                "promoted_to_active": "→ Active（直接拦截）",
                "demoted_to_shadow": "→ Shadow（静默对比）",
                "demoted_to_llm": "→ LLM（回退大模型）",
            }.get(p["action"], p["action"])
            report["messages"].append(f"    • {p['pattern']}: {action_cn}")
    
    # 过时更新
    if stale_updates:
        report["messages"].append(f"  🔄 过时结晶更新:")
        for s in stale_updates:
            if s["action"] == "solution_path_updated":
                report["messages"].append(
                    f"    • {s['pattern']}: 解决路径已更新 ({s['old_sig'][:6]}→{s['new_sig'][:6]})"
                )
            elif s["action"] == "demoted_unstable":
                report["messages"].append(
                    f"    • {s['pattern']}: 路径不稳定，降级 Stage {s['old_stage']}→{s['new_stage']}"
                )
    
    if not promotions and not stale_updates and active:
        report["messages"].append(
            f"  当前 {len(active)} 个 Shadow/Active 模式运行中，无变更"
        )
    
    return report


if __name__ == "__main__":
    date = sys.argv[1] if len(sys.argv) > 1 else None
    
    report = run_daily_reflection(date)
    
    print("=" * 60)
    print("每日反思报告 v2（举一反三 + 过时检测）")
    print("=" * 60)
    
    for msg in report.get("messages", []):
        print(msg)
    
    if report.get("total_interactions", 0) > 0:
        print(f"\n详细统计:")
        print(f"  分析窗口: {report['window']}")
        print(f"  窗口交互: {report['window_interactions']}")
        print(f"  当天交互: {report['total_interactions']}")
        print(f"  可结晶: {report['crystallizable']} ({report['crystallizable']/report['total_interactions']*100:.0f}%)")
        print(f"  纯推理: {report['reasoning_only']}")
        print(f"  唯一模式: {report['unique_patterns']}")
        print(f"  跨日模式: {len(report.get('cross_day_patterns', {}))}")
        if report.get("stage_changes"):
            print(f"  阶段变更: {len(report['stage_changes'])} 个")
        if report.get("stale_updates"):
            print(f"  过时更新: {len(report['stale_updates'])} 个")
        print(f"  活跃模式: {report.get('current_active_patterns', 0)}")
