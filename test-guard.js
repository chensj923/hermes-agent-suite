const { CommandGuard } = require('./apps/hermes-buddy-desktop/src/tools/guard.js');
const fs = require('fs');
const guard = new CommandGuard({ permission: 'read-write' });

const cmds = [
  `Get-Process | Format-Table Name, Id`,
  `Get-ChildItem | Format-List`,
  `Get-Service | Format-Wide`,
  `format d:`,
  `format.com d:`,
  `Format-Volume -DriveLetter D`,
  `Format D:`,
];

let out = '';
for (const cmd of cmds) {
  const v = guard.inspect(cmd);
  out += `[${v.action}/${v.category}${v.rule ? '/' + v.rule : ''}] ${cmd.slice(0, 60)}\n`;
}
fs.writeFileSync('test-guard.out.txt', out, 'utf8');
