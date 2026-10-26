#!/usr/bin/env python3
"""Prove byte preservation in the installed app's real SQLite database.

Uses synthetic fixtures only. Does not claim authenticated UI migration.
"""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path

STAMP = 1780000000789
presets = ['ender3-v3-ke'] * 4 + ['creality-k1c-2025', 'creality-k1-max', 'flashforge-ad5m']
printers = []
for index, preset in enumerate(presets, 1):
    flashforge = preset == 'flashforge-ad5m'
    edge = 300 if preset == 'creality-k1-max' else 220
    printers.append({
        'id': f'r141-upgrade-printer-{index}',
        'name': f'Мой принтер №{index} — {preset}', 'nameSource': 'custom',
        'host': f'127.0.0.1:{19000 + index}', 'catalogModelId': preset,
        'apiKeyStored': index == 7, 'tags': ['Сохранить при обновлении', f'Стеллаж {index}'],
        'profile': {'preset': preset, 'bedX': edge, 'bedY': edge,
                    'xMin': -110 if flashforge else 0, 'xMax': 110 if flashforge else edge,
                    'yMin': -110 if flashforge else 0, 'yMax': 110 if flashforge else edge,
                    'maxZ': 220 if flashforge else (300 if edge == 300 else 250),
                    'nozzle': 0.6 if index == 2 else 0.4, 'materials': ['PLA', 'PETG']},
        'modelSelection': {'mode': 'manual', 'selectedPreset': preset, 'source': 'manual'},
    })
spools = [
    {'id': 'r141-existing-pla', 'name': 'PLA белый — старая катушка', 'material': 'PLA',
     'color': '#ffffff', 'initialWeight': 1000, 'remainingWeight': 627.5, 'price': 1399,
     'currency': '₽', 'printerId': printers[0]['id'], 'createdAt': 1780000000123},
    {'id': 'r141-existing-petg', 'name': 'PETG чёрный', 'material': 'PETG',
     'initialWeight': 1000, 'remainingWeight': 83, 'price': 1550, 'currency': '₽',
     'createdAt': 1780000000456},
]
inventory = {
    'schemaVersion': 1, 'nextId': 17, 'createdAt': 1780000000123,
    'materials': {
        material: {'material': material, 'looseGrams': amount, 'reserveGrams': 5000,
                   'usedGrams': used, 'density': density, 'diameter': 1.75,
                   'reserveNotified': material == 'ABS'}
        for material, amount, used, density in [('PLA', 15000, 2372.5, 1.24),
                                               ('PETG', 7000, 917, 1.27), ('ABS', 4000, 0, 1.04)]
    },
    'spools': spools, 'printers': {
        row['id']: {'bindings': [], 'status': 'unbound', 'usedGrams': 1000 + index,
                    'calculatedGrams': 900 + index, 'manualGrams': 100,
                    'pendingJobs': 0, 'lastMilestoneKg': 1, 'byMaterial': {'PLA': 1000 + index}}
        for index, row in enumerate(printers)
    }, 'pending': [], 'processedJobs': {},
}
inventory['usageHistory'] = {'startedAt': 1780000000123, 'days': [
    {'day': '2026-05-28', 'printerId': printers[0]['id'], 'material': 'PLA', 'calculatedGrams': 900, 'manualGrams': 100},
    {'day': '2026-05-29', 'printerId': printers[1]['id'], 'material': 'PETG', 'calculatedGrams': 800, 'manualGrams': 100},
]}
values = {
    'production.cost': {'electricityPerKwh': 6.5, 'printerWatts': 350, 'laborPerHour': 150, 'currency': '₽'},
    'printers.config': printers,
    'production.spools': spools,
    'production.filamentInventory': inventory,
    'production.printerFiles.r141-upgrade-printer-7': {'version': 1, 'files': [], 'validations': {}},
}
# Preserve deliberate whitespace as well as JSON values and updated_at.
encoded = {key: json.dumps(value, ensure_ascii=False, indent=2) + '\n' for key, value in values.items()}

parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['seed', 'verify'])
parser.add_argument('--database', type=Path, required=True)
parser.add_argument('--proof', type=Path, required=True)
args = parser.parse_args()
args.database.parent.mkdir(parents=True, exist_ok=True)
with sqlite3.connect(args.database, timeout=10) as db:
    db.execute('PRAGMA busy_timeout=10000')
    if args.mode == 'seed':
        db.execute('CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
        for key, value in encoded.items():
            db.execute('INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', (key, value, STAMP))
    for key, value in encoded.items():
        row = db.execute('SELECT value,updated_at FROM kv WHERE key=?', (key,)).fetchone()
        if row != (value, STAMP):
            raise ValueError(f'Installed upgrade/launch changed preserved SQLite row: {key}')
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise ValueError('Installed SQLite integrity check failed')
report = {
    'passed': True, 'mode': args.mode, 'printerCount': len(printers), 'spoolCount': len(spools),
    'printerConfigurationBytesPreserved': True, 'legacySpoolBytesPreserved': True,
    'filamentInventoryBytesPreserved': True, 'materialReserveAndUsagePreserved': True,
    'costSettingsBytesPreserved': True,
    'sqliteIntegrity': 'ok',
    'rows': {key: {'valueSha256': hashlib.sha256(value.encode()).hexdigest(), 'updatedAt': STAMP}
             for key, value in encoded.items()},
    'scope': 'Actual installed SQLite preservation with synthetic data; authenticated UI and credential associations are verified separately by production React tests.',
}
args.proof.parent.mkdir(parents=True, exist_ok=True)
args.proof.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report))
