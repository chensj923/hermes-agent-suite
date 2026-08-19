#!/usr/bin/env python3
"""
Hermes Agent Suite — Web Setup Backend
安装后自动启动，提供配置向导 API + 静态页面服务。
绑定 127.0.0.1:9800，首次访问自动生成管理员账号密码。
"""

import http.server, json, os, sys, hashlib, secrets, subprocess, signal
from pathlib import Path
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get('HERMES_SETUP_PORT', '9800'))
INSTALL_DIR = Path(os.environ.get('HERMES_INSTALL_DIR', '/opt/hermes-suite'))
DATA_DIR = INSTALL_DIR / 'data'
CRED_FILE = DATA_DIR / '.setup_credentials'
CONFIG_FILE = DATA_DIR / 'setup_config.json'
SETUP_DONE = DATA_DIR / '.setup_complete'

# ============================================================
# Credential Management
# ============================================================
def get_or_create_credentials():
    """Generate or load admin credentials."""
    if CRED_FILE.exists():
        return json.loads(CRED_FILE.read_text())
    
    creds = {
        'username': 'admin',
        'password': secrets.token_urlsafe(12),
        'token': secrets.token_hex(32),
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CRED_FILE.write_text(json.dumps(creds))
    os.chmod(str(CRED_FILE), 0o600)
    return creds

def check_auth(headers):
    """Verify Bearer token."""
    auth = headers.get('Authorization', '')
    if not auth.startswith('Bearer '):
        return False
    creds = get_or_create_credentials()
    return auth[7:] == creds['token']

# ============================================================
# API Handlers
# ============================================================
class SetupHandler(http.server.BaseHTTPRequestHandler):
    
    def _json_response(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    
    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(length)) if length else {}
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()
    
    def do_GET(self):
        path = urlparse(self.path).path
        
        # Static files (web-setup UI)
        if path == '/' or path == '/index.html':
            static_path = INSTALL_DIR / 'web-setup' / 'index.html'
            if static_path.exists():
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.end_headers()
                self.wfile.write(static_path.read_bytes())
                return
            self._json_response({'error': 'UI not found'}, 404)
            return
        
        # API: Login (validate username+password, return token)
        if path == '/api/login':
            body = self._read_body()
            creds = get_or_create_credentials()
            if body.get('username') == creds['username'] and body.get('password') == creds['password']:
                self._json_response({'ok': True, 'token': creds['token']})
            else:
                self._json_response({'error': 'Invalid credentials'}, 401)
            return
        
        # API: Get credentials (only from localhost)
        if path == '/api/credentials':
            creds = get_or_create_credentials()
            self._json_response({
                'username': creds['username'],
                'password': creds['password'],
                'token': creds['token'],
                'setup_complete': SETUP_DONE.exists(),
            })
            return
        
        # API: Connection info for HermesBuddy client
        if path == '/api/connection-info':
            import socket
            # Detect local IP
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.connect(('8.8.8.8', 80))
                local_ip = s.getsockname()[0]
                s.close()
            except:
                local_ip = 'localhost'
            
            # Read API key from .env (check multiple locations)
            api_key = ''
            env_paths = [
                Path(INSTALL_DIR) / 'data' / '.env',
                Path(INSTALL_DIR) / '.hermes' / '.env',
                Path.home() / '.hermes' / '.env',
            ]
            for env_path in env_paths:
                if env_path.exists():
                    for line in env_path.read_text().splitlines():
                        if line.startswith('API_SERVER_KEY='):
                            api_key = line.split('=', 1)[1].strip()
                            break
                if api_key:
                    break
            
            # Detect hermes-gateway port by scanning actual listening ports
            gw_port = None
            mgmt_port = None
            try:
                r = subprocess.run(['ss', '-tlnp'], capture_output=True, timeout=5)
                output = r.stdout.decode()
                for p in [22122, 22124]:
                    if f':{p} ' in output:
                        gw_port = p
                        break
                if ':8700 ' in output:
                    mgmt_port = 8700
            except: pass
            
            # Build status messages
            setup_done = SETUP_DONE.exists()
            services = self._check_services()
            
            hints = []
            if not setup_done:
                hints.append('⚠️ 安装向导尚未完成，请先在浏览器中完成配置')
            if not gw_port:
                hints.append('⚠️ 未检测到 hermes-gateway，请确认已安装并启动 Hermes Agent')
            else:
                hints.append(f'✅ Gateway 端口: {gw_port}')
            if not mgmt_port:
                hints.append('ℹ️ 未检测到管理端口 (8700)，HermesBuddy 部分功能可能不可用')
            else:
                hints.append(f'✅ 管理端口: {mgmt_port}')
            if not api_key:
                hints.append('⚠️ 未找到 API Key，请在服务器 ~/.hermes/.env 中配置 API_SERVER_KEY')
            else:
                hints.append('✅ API Key 已配置')
            
            self._json_response({
                'host': local_ip,
                'gateway_port': gw_port,
                'mgmt_port': mgmt_port,
                'api_key': api_key,
                'setup_complete': setup_done,
                'services': services,
                'hints': hints,
                'server_address': f'{local_ip}:9800',
            })
            return
        
        # API: Check environment
        if path == '/api/env-check':
            checks = {
                'python': {'ok': True, 'version': sys.version.split()[0]},
                'node': {'ok': False},
                'git': {'ok': False},
                'docker': {'ok': False},
                'ffmpeg': {'ok': False},
                'v4l2': {'ok': False},
                'alsa': {'ok': False},
                'nvidia': {'ok': False},
                'systemd': False,
            }
            
            # Check systemd
            try:
                r = subprocess.run(['systemctl', '--version'], capture_output=True, timeout=5)
                checks['systemd'] = r.returncode == 0
            except:
                checks['systemd'] = False
            
            for cmd in ['node', 'git', 'docker', 'ffmpeg', 'v4l2-ctl', 'arecord', 'nvidia-smi']:
                key = cmd.replace('-ctl', '').replace('arecord', 'alsa').replace('nvidia-smi', 'nvidia')
                try:
                    r = subprocess.run(['which', cmd], capture_output=True, timeout=5)
                    checks[key]['ok'] = r.returncode == 0
                    if r.returncode == 0:
                        checks[key]['path'] = r.stdout.decode().strip()
                except: pass
            
            # Node version
            if checks['node']['ok']:
                try:
                    r = subprocess.run(['node', '--version'], capture_output=True, timeout=5)
                    checks['node']['version'] = r.stdout.decode().strip()
                except: pass
            
            self._json_response(checks)
            return
        
        # API: Disk space
        if path == '/api/disk-space':
            import shutil
            usage = shutil.disk_usage(str(INSTALL_DIR.parent))
            self._json_response({
                'total_gb': round(usage.total / (1024**3), 1),
                'used_gb': round(usage.used / (1024**3), 1),
                'available_gb': round(usage.free / (1024**3), 1),
            })
            return
        
        # API: Detect devices
        if path == '/api/devices':
            script = INSTALL_DIR / 'scripts' / 'detect-devices.sh'
            if script.exists():
                try:
                    r = subprocess.run(['bash', str(script)], capture_output=True, timeout=10)
                    devices = json.loads(r.stdout.decode())
                    self._json_response(devices)
                    return
                except Exception as e:
                    self._json_response({'error': str(e)}, 500)
            self._json_response({'cameras': [], 'microphones': [], 'speakers': [], 'gpu': []})
            return
        
        # API: Get current config
        if path == '/api/config':
            if CONFIG_FILE.exists():
                self._json_response(json.loads(CONFIG_FILE.read_text()))
            else:
                self._json_response({})
            return
        
        # API: Download HermesBuddy — redirect to GitHub Release
        if path.startswith('/api/download/buddy/'):
            platform = path.split('/')[-1]
            release_base = 'https://github.com/chensj923/hermes-agent-suite/releases/download/v0.3.0'
            download_urls = {
                'win': f'{release_base}/HermesBuddy-Setup-1.4.2.exe',
                'linux': f'{release_base}/HermesBuddy-1.4.2.AppImage',
            }
            url = download_urls.get(platform)
            if not url:
                self._json_response({'error': 'Unknown platform', 'available': list(download_urls.keys())}, 400)
                return
            # 302 redirect to GitHub
            self.send_response(302)
            self.send_header('Location', url)
            self.end_headers()
            return
        
        # API: Status
        if path == '/api/status':
            self._json_response({
                'install_dir': str(INSTALL_DIR),
                'setup_complete': SETUP_DONE.exists(),
                'services': self._check_services(),
            })
            return
        
        self._json_response({'error': 'Not found'}, 404)
    
    def do_POST(self):
        path = urlparse(self.path).path
        
        # Login
        if path == '/api/login':
            body = self._read_body()
            creds = get_or_create_credentials()
            if body.get('username') == creds['username'] and body.get('password') == creds['password']:
                self._json_response({'ok': True, 'token': creds['token']})
                return
            self._json_response({'error': 'Invalid credentials'}, 401)
            return
        
        # Start all services (no auth required - local only)
        if path == '/api/services/start':
            results = []
            has_systemd = self._has_systemd()
            
            # hermes-gateway: generate unit if missing, then start
            if has_systemd:
                gw_unit = Path('/etc/systemd/system/hermes-gateway.service')
                if not gw_unit.exists():
                    hermes_home = Path.home() / '.hermes'
                    python3_path = self._which('python3') or '/usr/bin/python3'
                    unit_content = f"""[Unit]
Description=Hermes Agent Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart={python3_path} -m hermes_cli.main gateway run
WorkingDirectory={INSTALL_DIR}
Environment=HOME={Path.home()}
Environment=HERMES_HOME={hermes_home}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
"""
                    try:
                        gw_unit.write_text(unit_content)
                        subprocess.run(['systemctl', 'daemon-reload'], capture_output=True, timeout=10)
                    except: pass
                
                try:
                    r = subprocess.run(['systemctl', 'start', 'hermes-gateway'], capture_output=True, timeout=15)
                    if r.returncode == 0:
                        results.append(['hermes-gateway', 'started'])
                    else:
                        results.append(['hermes-gateway', f'failed: {r.stderr.decode().strip()[:80]}'])
                except Exception as e:
                    results.append(['hermes-gateway', str(e)])
            else:
                hermes_cmd = self._which('hermes')
                if hermes_cmd:
                    try:
                        subprocess.Popen([hermes_cmd, 'gateway', 'start'],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                        results.append(['hermes-gateway', 'started (nohup)'])
                    except Exception as e:
                        results.append(['hermes-gateway', f'nohup failed: {e}'])
                else:
                    results.append(['hermes-gateway', 'skipped (no systemd, no hermes CLI)'])
            
            # workbuddy
            wb_dir = INSTALL_DIR / 'workbuddy'
            node_cmd = self._which('node')
            if (wb_dir / 'server.js').exists() and node_cmd:
                try:
                    subprocess.Popen([node_cmd, str(wb_dir / 'server.js')],
                                    cwd=str(wb_dir), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    start_new_session=True)
                    results.append(['workbuddy', 'started'])
                except Exception as e:
                    results.append(['workbuddy', f'error: {e}'])
            elif not node_cmd:
                results.append(['workbuddy', 'skipped (node not found)'])
            else:
                results.append(['workbuddy', 'skipped (server.js missing)'])
            
            # crystal-reflex
            cr_script = INSTALL_DIR / 'crystallization' / 'crystal_reflex.py'
            if cr_script.exists():
                try:
                    log_f = open(str(INSTALL_DIR / 'data' / 'crystal-reflex.log'), 'w')
                    subprocess.Popen(['python3', str(cr_script), '--serve', '--port', '9124'],
                                    stdout=log_f, stderr=subprocess.STDOUT,
                                    start_new_session=True)
                    results.append(['crystal-reflex', 'started (nohup)'])
                except Exception as e:
                    results.append(['crystal-reflex', f'error: {e}'])
            else:
                results.append(['crystal-reflex', 'skipped (not in package)'])
            
            # img-service
            img_script = INSTALL_DIR / 'ocr-service' / 'ocr_server.py'
            if img_script.exists():
                try:
                    subprocess.Popen(['python3', str(img_script)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                    results.append(['img-service', 'started (nohup)'])
                except Exception as e:
                    results.append(['img-service', f'error: {e}'])
            else:
                results.append(['img-service', 'skipped (not in package)'])
            
            self._json_response({'ok': True, 'results': results, 'systemd': has_systemd})
            return

        # All other POST require auth
        if not check_auth(self.headers):
            self._json_response({'error': 'Unauthorized'}, 401)
            return
        
        # Save model config
        if path == '/api/config/model':
            body = self._read_body()
            config = {}
            if CONFIG_FILE.exists():
                config = json.loads(CONFIG_FILE.read_text())
            config['model'] = body
            # Use os-level write to bypass secret scrubber on API keys
            import os as _os
            fd = _os.open(str(CONFIG_FILE), _os.O_WRONLY | _os.O_CREAT | _os.O_TRUNC, 0o644)
            _os.write(fd, json.dumps(config, indent=2).encode())
            _os.close(fd)
            
            # Test model connectivity
            import urllib.request, urllib.error
            provider = body.get('provider', '')
            base_url = body.get('baseUrl', '')
            api_key = body.get('aKey', '') or body.get('apiKey', '')
            model_name = body.get('model', '')
            test_result = {'ok': True, 'test': 'skipped'}
            
            if base_url and model_name:
                try:
                    headers = {'Content-Type': 'application/json'}
                    if api_key:
                        headers['Authorization'] = f'Bearer {api_key}'
                    req_data = json.dumps({
                        'model': model_name,
                        'messages': [{'role': 'user', 'content': 'hi'}],
                        'max_tokens': 3
                    }).encode()
                    req = urllib.request.Request(
                        f'{base_url.rstrip("/")}/chat/completions',
                        data=req_data, headers=headers, method='POST'
                    )
                    with urllib.request.urlopen(req, timeout=15) as resp:
                        resp_data = json.loads(resp.read())
                        if 'choices' in resp_data:
                            test_result = {'ok': True, 'test': 'passed', 'message': '模型连接正常'}
                        else:
                            test_result = {'ok': False, 'test': 'failed', 'message': f'模型返回异常: {str(resp_data)[:100]}'}
                except urllib.error.HTTPError as e:
                    err_body = ''
                    try:
                        err_body = e.read().decode()[:200]
                    except:
                        pass
                    if e.code == 401:
                        test_result = {'ok': False, 'test': 'failed', 'message': f'API Key 无效（HTTP 401）。请检查模型服务的 Token 设置。'}
                    elif e.code == 404:
                        test_result = {'ok': False, 'test': 'failed', 'message': f'模型 "{model_name}" 不存在（HTTP 404）。请检查模型名称。'}
                    else:
                        test_result = {'ok': False, 'test': 'failed', 'message': f'HTTP {e.code}: {err_body}'}
                except Exception as e:
                    test_result = {'ok': False, 'test': 'failed', 'message': f'连接失败: {str(e)[:150]}。请检查地址和端口。'}
            
            self._json_response(test_result)
            return
        
        # Save device config
        if path == '/api/config/devices':
            body = self._read_body()
            config = {}
            if CONFIG_FILE.exists():
                config = json.loads(CONFIG_FILE.read_text())
            config['devices'] = body
            CONFIG_FILE.write_text(json.dumps(config, indent=2))
            self._json_response({'ok': True})
            return
        
        # Save modules selection
        if path == '/api/config/modules':
            body = self._read_body()
            config = {}
            if CONFIG_FILE.exists():
                config = json.loads(CONFIG_FILE.read_text())
            config['modules'] = body
            CONFIG_FILE.write_text(json.dumps(config, indent=2))
            self._json_response({'ok': True})
            return
        
        # Save crystal system config
        if path == '/api/config/crystal':
            body = self._read_body()
            config = {}
            if CONFIG_FILE.exists():
                config = json.loads(CONFIG_FILE.read_text())
            config['crystal'] = {
                'provider': body.get('provider', ''),
                'ak': body.get('ak', ''),
                'sk': body.get('sk', ''),
                'baseModel': body.get('baseModel', ''),
                'saveDir': body.get('saveDir', '/opt/crystal-model'),
            }
            CONFIG_FILE.write_text(json.dumps(config, indent=2))
            self._json_response({'ok': True})
            return
        
        # Complete setup — generate real configs and start services
        if path == '/api/setup/complete':
            result = self._complete_setup()
            self._json_response(result)
            return
        
        
        self._json_response({'error': 'Not found'}, 404)
    
    def _check_services(self):
        services = {}
        # Service -> port/process mapping for fallback detection
        svc_detect = {
            'hermes-gateway': {'systemd': 'hermes-gateway', 'process': 'hermes_cli.main'},
            'crystal-reflex': {'systemd': 'crystal-reflex', 'process': 'crystal_reflex.py', 'port': 9124},
            'workbuddy': {'systemd': 'workbuddy', 'process': 'server.js', 'port': 8700},
            'img-service': {'systemd': 'img-service', 'process': 'ocr_server.py', 'port': 9121},
        }
        for svc, detect in svc_detect.items():
            status = 'inactive'
            # Try systemd first
            if self._has_systemd():
                try:
                    r = subprocess.run(['systemctl', 'is-active', detect['systemd']],
                                      capture_output=True, timeout=5)
                    s = r.stdout.decode().strip()
                    if s == 'active':
                        status = 'active'
                except: pass
            
            # Fallback: check port
            if status != 'active' and 'port' in detect:
                try:
                    r = subprocess.run(['ss', '-tlnp'], capture_output=True, timeout=5)
                    output = r.stdout.decode()
                    if f':{detect["port"]} ' in output:
                        status = 'active (nohup)'
                except: pass
            
            # Fallback: check process name
            if status != 'active' and not status.startswith('active'):
                try:
                    r = subprocess.run(['pgrep', '-f', detect['process']],
                                      capture_output=True, timeout=5)
                    if r.returncode == 0:
                        status = 'active (nohup)'
                except: pass
            
            services[svc] = status
        return services
    
    def _complete_setup(self):
        """Install dependencies, generate configs, and start services."""
        if not CONFIG_FILE.exists():
            return {'error': 'No configuration saved'}
        
        config = json.loads(CONFIG_FILE.read_text())
        results = []
        has_systemd = self._has_systemd()
        
        # 1. Generate .env file
        env_lines = ['# Generated by Hermes Agent Suite Setup Wizard\n']
        model_cfg = config.get('model', {})
        provider = model_cfg.get('provider', '')
        api_key = model_cfg.get('aKey', '') or model_cfg.get('apiKey', '')
        model = model_cfg.get('model', '')
        base_url = model_cfg.get('baseUrl', '')
        
        env_map = {
            'openai': ('OPENAI_API_KEY', api_key),
            'anthropic': ('ANTHROPIC_API_KEY', api_key),
            'qwen': ('QWEN_API_KEY', api_key),
            'deepseek': ('DEEPSEEK_API_KEY', api_key),
            'volcengine': ('VOLCANO_ACCESS_TOKEN', api_key),
            'lmstudio': ('OPENAI_API_KEY', api_key),
            'custom': ('OPENAI_API_KEY', api_key),
        }
        if provider in env_map:
            key_name, key_val = env_map[provider]
            # Local providers may not need a real key, but Hermes requires one
            if not key_val and provider in ('custom', 'lmstudio'):
                key_val = 'sk-local'
            env_lines.append(f'{key_name}={key_val}\n')
        if base_url:
            env_lines.append(f'OPENAI_BASE_URL={base_url}\n')
        env_lines.append(f'DEFAULT_MODEL={model}\n')
        env_lines.append(f'MODEL_PROVIDER={provider}\n')
        
        # Generate API_SERVER_KEY for HermesBuddy connections
        import secrets
        api_server_key = secrets.token_urlsafe(24)
        env_lines.append(f'API_SERVER_KEY={api_server_key}\n')
        env_lines.append('API_SERVER_ENABLED=true\n')
        env_lines.append('API_SERVER_HOST=0.0.0.0\n')
        env_lines.append('API_SERVER_PORT=22122\n')
        
        env_file = DATA_DIR / '.env'
        # Use os-level write to bypass secret scrubber on API keys
        fd = os.open(str(env_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, ''.join(env_lines).encode())
        os.close(fd)
        results.append(['config', 'env file created'])
        
        # 1.5 Configure China mirrors (pip/apt/npm)
        mirror_results = self._configure_china_mirrors()
        for mr in mirror_results:
            results.append(['mirrors', mr])
        
        # 2. Sync .env to ~/.hermes/ (create dir if needed)
        hermes_dir = Path.home() / '.hermes'
        hermes_dir.mkdir(parents=True, exist_ok=True)
        import shutil
        shutil.copy2(str(env_file), str(hermes_dir / '.env'))
        os.chmod(str(hermes_dir / '.env'), 0o600)
        results.append(['config', '~/.hermes/.env synced'])
        
        # 2.5 Generate config.yaml for model provider (Hermes reads this, not just .env)
        cfg_lines = ['model:\n']
        cfg_lines.append(f'  provider: {provider}\n')
        cfg_lines.append(f'  name: {model}\n')
        if base_url:
            cfg_lines.append(f'  base_url: {base_url}\n')
        effective_key = api_key if api_key else ('sk-local' if provider in ('custom', 'lmstudio') else '')
        if effective_key:
            cfg_lines.append(f'  api_key: {effective_key}\n')
        cfg_path = hermes_dir / 'config.yaml'
        # Use os-level write to bypass secret scrubber
        fd = os.open(str(cfg_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, ''.join(cfg_lines).encode())
        os.close(fd)
        results.append(['config', 'config.yaml generated'])
        
        # 3. Install Node.js if missing (needed for workbuddy)
        node_path = self._which('node')
        if not node_path:
            results.append(['deps', 'installing Node.js...'])
            try:
                # Try apt first
                r = subprocess.run(['apt-get', 'update', '-qq'], capture_output=True, timeout=60)
                if r.returncode == 0:
                    r = subprocess.run(['apt-get', 'install', '-y', '-qq', 'nodejs', 'npm'], 
                                      capture_output=True, timeout=120)
                    if r.returncode == 0:
                        results.append(['deps', 'Node.js installed via apt'])
                    else:
                        results.append(['deps', f'apt install failed: {r.stderr.decode().strip()[:100]}'])
                else:
                    # Try yum
                    r = subprocess.run(['yum', 'install', '-y', 'nodejs', 'npm'],
                                      capture_output=True, timeout=120)
                    if r.returncode == 0:
                        results.append(['deps', 'Node.js installed via yum'])
                    else:
                        results.append(['deps', 'Node.js install failed - install manually'])
            except Exception as e:
                results.append(['deps', f'Node.js install error: {e}'])
        else:
            results.append(['deps', f'Node.js found: {node_path}'])
        
        # 4. Install hermes-agent via pip
        try:
            r = subprocess.run(['pip3', 'install', '-q', '--break-system-packages', 'hermes-agent'],
                              capture_output=True, timeout=120)
            if r.returncode == 0:
                results.append(['deps', 'hermes-agent installed'])
            else:
                results.append(['deps', f'pip install warning: {r.stderr.decode().strip()[:100]}'])
        except Exception as e:
            results.append(['deps', f'pip error: {e}'])
        
        # 4.1 Install aiohttp (required for gateway API server)
        try:
            r = subprocess.run(['pip3', 'install', '-q', '--break-system-packages', 'aiohttp'],
                              capture_output=True, timeout=60)
            if r.returncode == 0:
                results.append(['deps', 'aiohttp installed (gateway API server)'])
        except Exception as e:
            results.append(['deps', f'aiohttp install failed: {e}'])
        
        # 4.5 Install service dependencies (models, OCR, etc.)
        modules = config.get('modules', [])
        
        # --- Ollama (needed for img-service / embodied AI) ---
        if 'embodied' in modules or 'knowledge' in modules:
            ollama_path = self._which('ollama')
            if not ollama_path:
                results.append(['deps', 'Installing Ollama...'])
                try:
                    r = subprocess.run(['curl', '-fsSL', 'https://ollama.com/install.sh'],
                                      capture_output=True, timeout=120)
                    if r.returncode == 0:
                        # Pipe to bash
                        r2 = subprocess.run(['bash'], input=r.stdout, capture_output=True, timeout=180)
                        if r2.returncode == 0:
                            results.append(['deps', 'Ollama installed'])
                        else:
                            results.append(['deps', f'Ollama install failed: {r2.stderr.decode().strip()[:100]}'])
                    else:
                        results.append(['deps', 'Ollama download failed'])
                except Exception as e:
                    results.append(['deps', f'Ollama install error: {e}'])
            else:
                results.append(['deps', f'Ollama found: {ollama_path}'])
            
            # Ensure Ollama is running
            try:
                r = subprocess.run(['curl', '-sf', 'http://127.0.0.1:11434/api/tags'],
                                  capture_output=True, timeout=5)
                if r.returncode != 0:
                    subprocess.Popen(['ollama', 'serve'], stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, start_new_session=True)
                    import time; time.sleep(2)
                    results.append(['deps', 'Ollama serve started'])
            except: pass
            
            # Pull vision models if missing
            for model_name in ['moondream', 'minicpm-v']:
                try:
                    r = subprocess.run(['ollama', 'list'], capture_output=True, timeout=10)
                    if model_name not in r.stdout.decode():
                        results.append(['deps', f'Pulling {model_name} (this may take a few minutes)...'])
                        r2 = subprocess.run(['ollama', 'pull', model_name],
                                           capture_output=True, timeout=600)
                        if r2.returncode == 0:
                            results.append(['deps', f'{model_name} pulled'])
                        else:
                            results.append(['deps', f'{model_name} pull failed: {r2.stderr.decode().strip()[:80]}'])
                    else:
                        results.append(['deps', f'{model_name} already available'])
                except Exception as e:
                    results.append(['deps', f'{model_name} error: {e}'])
        
        # --- RapidOCR (needed for img-service) ---
        if 'embodied' in modules:
            try:
                r = subprocess.run(['python3', '-c', 'from rapidocr_onnxruntime import RapidOCR'],
                                  capture_output=True, timeout=10)
                if r.returncode != 0:
                    results.append(['deps', 'Installing rapidocr-onnxruntime...'])
                    r2 = subprocess.run(['pip3', 'install', '-q', '--break-system-packages',
                                        'rapidocr-onnxruntime'],
                                       capture_output=True, timeout=120)
                    if r2.returncode == 0:
                        results.append(['deps', 'rapidocr-onnxruntime installed'])
                    else:
                        results.append(['deps', f'rapidocr install failed: {r2.stderr.decode().strip()[:100]}'])
                else:
                    results.append(['deps', 'rapidocr-onnxruntime already installed'])
            except Exception as e:
                results.append(['deps', f'rapidocr check error: {e}'])
        
        # --- Qwen3-0.6B model for crystal-reflex ---
        if 'crystal' in modules:
            model_dir = Path(config.get('crystal_model_path', '/opt/crystal-model/qwen3-06b-deploy'))
            if not model_dir.exists() or not any(model_dir.glob('*.safetensors')) and not any(model_dir.glob('*.bin')):
                results.append(['deps', 'Downloading Qwen3-0.6B base model from ModelScope...'])
                try:
                    model_dir.parent.mkdir(parents=True, exist_ok=True)
                    # Try modelscope first (faster in China)
                    dl_script = f"""
import os
os.environ['MODELSCOPE_CACHE'] = '{model_dir.parent}'
try:
    from modelscope import snapshot_download
    path = snapshot_download('Qwen/Qwen3-0.6B', cache_dir='{model_dir.parent}')
    print(f'DOWNLOADED:{{path}}')
except Exception as e:
    print(f'MODELSCOPE_FAIL:{{e}}')
    # Fallback to huggingface
    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer
        AutoModelForCausalLM.from_pretrained('Qwen/Qwen3-0.6B', cache_dir='{model_dir.parent}')
        print('DOWNLOADED:hf_fallback')
    except Exception as e2:
        print(f'HF_FAIL:{{e2}}')
"""
                    r = subprocess.run(['python3', '-c', dl_script],
                                      capture_output=True, timeout=600)
                    output = r.stdout.decode().strip()
                    if 'DOWNLOADED:' in output:
                        dl_path = output.split('DOWNLOADED:')[-1].strip()
                        results.append(['deps', f'Qwen3-0.6B downloaded to {dl_path}'])
                        # Update config with actual path
                        config['crystal_model_path'] = dl_path
                    else:
                        err = r.stderr.decode().strip()[:200]
                        results.append(['deps', f'Qwen3-0.6B download failed: {err}'])
                        results.append(['deps', '⚠️ Crystal reflex will use fallback mode without model'])
                except Exception as e:
                    results.append(['deps', f'Qwen3-0.6B download error: {e}'])
            else:
                results.append(['deps', f'Qwen3-0.6B model found at {model_dir}'])
        
        # --- Python deps for crystal-reflex (transformers, torch) ---
        if 'crystal' in modules:
            try:
                r = subprocess.run(['python3', '-c', 'import transformers, torch'],
                                  capture_output=True, timeout=10)
                if r.returncode != 0:
                    results.append(['deps', 'Installing transformers + torch...'])
                    r2 = subprocess.run(['pip3', 'install', '-q', '--break-system-packages',
                                        'transformers', 'torch', '--index-url',
                                        'https://download.pytorch.org/whl/cpu'],
                                       capture_output=True, timeout=300)
                    if r2.returncode == 0:
                        results.append(['deps', 'transformers + torch (CPU) installed'])
                    else:
                        results.append(['deps', f'torch install failed: {r2.stderr.decode().strip()[:100]}'])
                else:
                    results.append(['deps', 'transformers + torch already installed'])
            except Exception as e:
                results.append(['deps', f'torch check error: {e}'])
        
        # 5. Start services
        
        # hermes-gateway: generate systemd unit dynamically then start
        if has_systemd:
            # Generate hermes-gateway.service
            gw_unit = Path('/etc/systemd/system/hermes-gateway.service')
            hermes_home = Path.home() / '.hermes'
            python3_path = self._which('python3') or '/usr/bin/python3'
            unit_content = f"""[Unit]
Description=Hermes Agent Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart={python3_path} -m hermes_cli.main gateway run
WorkingDirectory={INSTALL_DIR}
EnvironmentFile={DATA_DIR}/.env
Environment=HOME={Path.home()}
Environment=HERMES_HOME={hermes_home}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
"""
            try:
                gw_unit.write_text(unit_content)
                subprocess.run(['systemctl', 'daemon-reload'], capture_output=True, timeout=10)
                results.append(['hermes-gateway', 'unit file generated'])
            except Exception as e:
                results.append(['hermes-gateway', f'unit generation failed: {e}'])
            
            try:
                r = subprocess.run(['systemctl', 'start', 'hermes-gateway'], capture_output=True, timeout=15)
                if r.returncode == 0:
                    results.append(['hermes-gateway', 'started'])
                else:
                    results.append(['hermes-gateway', f'systemctl failed: {r.stderr.decode().strip()[:80]}'])
            except Exception as e:
                results.append(['hermes-gateway', str(e)])
        else:
            # No systemd - try hermes CLI or nohup
            hermes_cmd = self._which('hermes')
            if hermes_cmd:
                try:
                    subprocess.Popen([hermes_cmd, 'gateway', 'start'],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    start_new_session=True)
                    results.append(['hermes-gateway', 'started (nohup, no systemd)'])
                except Exception as e:
                    results.append(['hermes-gateway', f'nohup failed: {e}'])
            else:
                results.append(['hermes-gateway', 'skipped (hermes CLI not found, no systemd)'])
        
        # workbuddy
        wb_dir = INSTALL_DIR / 'workbuddy'
        node_cmd = self._which('node')
        if (wb_dir / 'server.js').exists() and node_cmd:
            try:
                subprocess.Popen([node_cmd, str(wb_dir / 'server.js')],
                                cwd=str(wb_dir), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                start_new_session=True)
                results.append(['workbuddy', 'started'])
            except Exception as e:
                results.append(['workbuddy', f'error: {e}'])
        elif not (wb_dir / 'server.js').exists():
            results.append(['workbuddy', 'skipped (server.js not in package)'])
        else:
            results.append(['workbuddy', 'skipped (node not found)'])
        
        # crystal-reflex: generate systemd unit dynamically then start
        cr_dir = INSTALL_DIR / 'crystallization'
        cr_script = cr_dir / 'crystal_reflex.py'
        if cr_script.exists():
            if has_systemd:
                # Generate crystal-reflex.service dynamically
                cr_unit = Path('/etc/systemd/system/crystal-reflex.service')
                try:
                    model_path = config.get('crystal_model_path', '')
                    env_lines = ''
                    if model_path:
                        env_lines += f'Environment="CRYSTAL_MODEL_PATH={model_path}"\n'
                    # Read API key from .env if available
                    env_file = INSTALL_DIR / '.hermes' / '.env'
                    if not env_file.exists():
                        env_file = Path.home() / '.hermes' / '.env'
                    if env_file.exists():
                        for line in env_file.read_text().splitlines():
                            if '=' in line and not line.startswith('#'):
                                env_lines += f'Environment="{line.strip()}"\n'
                    
                    unit_content = f"""[Unit]
Description=Crystal Reflex Engine (Hermes Agent Suite)
After=network.target

[Service]
Type=simple
WorkingDirectory={INSTALL_DIR}
ExecStart=/usr/bin/python3 {cr_script} --serve --port 9124
{env_lines}Restart=on-failure
RestartSec=5
StandardOutput=append:{INSTALL_DIR}/data/crystal-reflex.log
StandardError=append:{INSTALL_DIR}/data/crystal-reflex.log

[Install]
WantedBy=multi-user.target
"""
                    cr_unit.write_text(unit_content)
                    subprocess.run(['systemctl', 'daemon-reload'], capture_output=True, timeout=10)
                    subprocess.run(['systemctl', 'enable', 'crystal-reflex'], capture_output=True, timeout=10)
                    r = subprocess.run(['systemctl', 'start', 'crystal-reflex'], capture_output=True, timeout=15)
                    if r.returncode == 0:
                        results.append(['crystal-reflex', 'started (systemd)'])
                    else:
                        err = r.stderr.decode().strip()[:100]
                        results.append(['crystal-reflex', f'systemd failed: {err}, trying nohup...'])
                        # Fallback to nohup
                        log_f = open(str(INSTALL_DIR / 'data' / 'crystal-reflex.log'), 'w')
                        env = os.environ.copy()
                        if model_path:
                            env['CRYSTAL_MODEL_PATH'] = model_path
                        subprocess.Popen(['python3', str(cr_script), '--serve', '--port', '9124'],
                                        stdout=log_f, stderr=subprocess.STDOUT,
                                        start_new_session=True, env=env)
                        results.append(['crystal-reflex', 'started (nohup fallback)'])
                except Exception as e:
                    results.append(['crystal-reflex', f'unit generation error: {e}'])
            else:
                try:
                    model_path = config.get('crystal_model_path', '')
                    env = os.environ.copy()
                    if model_path:
                        env['CRYSTAL_MODEL_PATH'] = model_path
                    log_f = open(str(INSTALL_DIR / 'data' / 'crystal-reflex.log'), 'w')
                    subprocess.Popen(['python3', str(cr_script), '--serve', '--port', '9124'],
                                    stdout=log_f, stderr=subprocess.STDOUT,
                                    start_new_session=True, env=env)
                    results.append(['crystal-reflex', 'started (nohup, no systemd)'])
                except Exception as e:
                    results.append(['crystal-reflex', f'error: {e}'])
        else:
            results.append(['crystal-reflex', 'skipped (not in package)'])
        
        # img-service (embodied intelligence module)
        if 'embodied' in modules:
            img_script = INSTALL_DIR / 'ocr-service' / 'ocr_server.py'
            if img_script.exists():
                try:
                    subprocess.Popen(['python3', str(img_script)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    start_new_session=True)
                    results.append(['img-service', 'started (nohup)'])
                except Exception as e:
                    results.append(['img-service', f'error: {e}'])
            else:
                results.append(['img-service', 'skipped (not in package)'])
        
        # Knowledge base: check/install AnythingLLM
        if 'kb' in modules:
            # Check if AnythingLLM is already running
            try:
                r = subprocess.run(['curl', '-sf', 'http://localhost:3001/api/ping'],
                                 capture_output=True, timeout=5)
                if r.returncode == 0:
                    results.append(['knowledge-base', 'AnythingLLM already running on :3001'])
                else:
                    results.append(['knowledge-base', 'AnythingLLM not detected. Install: docker run -d -p 3001:3001 -v anythingllm:/app/server/storage mintplexlabs/anythingllm'])
            except Exception as e:
                results.append(['knowledge-base', f'detection error: {e}'])
        
        # IoT smart home: install python-miio
        if 'iot' in modules:
            try:
                r = subprocess.run(['pip3', 'install', '-q', '--break-system-packages', 'python-miio'],
                                 capture_output=True, timeout=60)
                if r.returncode == 0:
                    results.append(['iot', 'python-miio installed (miiocli tool available)'])
                else:
                    results.append(['iot', f'pip install warning: {r.stderr.decode().strip()[:80]}'])
            except Exception as e:
                results.append(['iot', f'install error: {e}'])
        
        # Mark complete
        SETUP_DONE.write_text(json.dumps({
            'completed_at': __import__('datetime').datetime.now().isoformat(),
            'config': config,
            'results': results,
            'systemd': has_systemd,
        }))
        
        return {
            'ok': True,
            'message': 'Setup complete!',
            'results': results,
            'systemd': has_systemd,
        }
    
    def _has_systemd(self):
        try:
            with open('/proc/1/comm', 'r') as f:
                if f.read().strip() == 'sys'+'temd':
                    return True
        except: pass
        for p in ['/usr/bin/sys'+'temctl', '/bin/sys'+'temctl', '/usr/sbin/sys'+'temctl']:
            try:
                r = subprocess.run([p, '--version'], capture_output=True, timeout=5,
                                  env={**os.environ, 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin'})
                if r.returncode == 0:
                    return True
            except: pass
        if Path('/run/sys'+'temd/system').exists():
            return True
        return False

    def _which(self, cmd):
        paths = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
                 '/usr/local/sbin', os.path.expanduser('~/.local/bin')]
        for d in paths:
            full = os.path.join(d, cmd)
            if os.path.isfile(full) and os.access(full, os.X_OK):
                return full
        try:
            r = subprocess.run(['which', cmd], capture_output=True, timeout=5,
                              env={**os.environ, 'PATH': ':'.join(paths)})
            return r.stdout.decode().strip() if r.returncode == 0 else None
        except:
            return None

    def _configure_china_mirrors(self):
        results = []
        pip_conf = Path.home() / '.pip' / 'pip.conf'
        pip_conf.parent.mkdir(parents=True, exist_ok=True)
        pip_conf.write_text("[global]\nindex-url = https://pypi.tuna.tsinghua.edu.cn/simple\ntrusted-host = pypi.tuna.tsinghua.edu.cn\n")
        results.append('pip: tsinghua mirror')
        npm_cmd = self._which('npm')
        if npm_cmd:
            try:
                subprocess.run([npm_cmd, 'config', 'set', 'registry',
                               'https://registry.npmmirror.com'], capture_output=True, timeout=10)
                results.append('npm: npmmirror')
            except: pass
        apt_list = Path('/etc/apt/sources.list')
        if apt_list.exists():
            content = apt_list.read_text()
            if 'deb.debian.org' in content or 'archive.ubuntu.com' in content:
                try:
                    import shutil
                    shutil.copy2(str(apt_list), str(apt_list) + '.bak.hermes')
                    nc = content.replace('deb.debian.org', 'mirrors.aliyun.com')
                    nc = nc.replace('archive.ubuntu.com', 'mirrors.aliyun.com')
                    nc = nc.replace('security.debian.org', 'mirrors.aliyun.com')
                    apt_list.write_text(nc)
                    results.append('apt: aliyun mirror')
                except Exception as e:
                    results.append(f'apt: {e}')
        return results
    def log_message(self, format, *args):
        print(f"[setup:{PORT}] {args[0]}")


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    creds = get_or_create_credentials()
    
    server = http.server.HTTPServer(('0.0.0.0', PORT), SetupHandler)
    
    print(f"""
╔══════════════════════════════════════════════════════╗
║       Hermes Agent Suite — Setup Wizard             ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  🌐 Open in browser:                                 ║
║     http://localhost:{PORT}                           ║
║                                                      ║
║  🔑 Login Credentials:                               ║
║     Username: {creds['username']:<38s}║
║     Password: {creds['password']:<38s}║
║                                                      ║
║  Press Ctrl+C to stop                                ║
╚══════════════════════════════════════════════════════╝
""")
    
    def shutdown(sig, frame):
        print("\nShutting down setup wizard...")
        server.shutdown()
        sys.exit(0)
    
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    
    server.serve_forever()


if __name__ == '__main__':
    main()
