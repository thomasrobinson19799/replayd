"""Build a deterministic, installable plugin ZIP using only the Python standard library."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import re

root = Path(__file__).resolve().parents[1]
plugin = root / 'wordpress' / 'replayd-wp'
main = plugin / 'replayd-wp.php'
version = re.search(r'^\s*\*?\s*Version:\s*([0-9][0-9A-Za-z.+-]*)', main.read_text(encoding='utf-8'), re.M)
if not version:
    raise SystemExit('Plugin version header missing')
output = root / 'data' / 'releases' / f'replayd-wp-{version[1]}.zip'
output.parent.mkdir(parents=True, exist_ok=True)
files = [p for p in sorted(plugin.rglob('*')) if p.is_file() and 'tests' not in p.relative_to(plugin).parts and p.suffix in ('.php', '.txt', '.md', '.mo', '.po')]
with ZipFile(output, 'w', compression=ZIP_DEFLATED) as archive:
    for path in files:
        info = ZipInfo('replayd-wp/' + path.relative_to(plugin).as_posix(), (2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        archive.writestr(info, path.read_bytes())
with ZipFile(output) as archive:
    assert archive.testzip() is None
    assert 'replayd-wp/replayd-wp.php' in archive.namelist()
print(f'Packaged {len(files)} files: {output}')
