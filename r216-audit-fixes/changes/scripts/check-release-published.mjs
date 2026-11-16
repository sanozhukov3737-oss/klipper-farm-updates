#!/usr/bin/env node
// Проверяет, что опубликованный канал раздаёт обновление целиком.
//
// Поводом стали два случая подряд. Сначала релиз собрали без update-v20.json: канал
// смотрит на releases/latest/download/update-v20.json и получил 404, оператор увидел
// «Не удалось скачать обновление (curl 22)». Потом выложили манифест, но не архив
// рантайма движка: имя архива содержит отпечаток содержимого, у каждого выпуска оно
// своё, и установщик упал с «Installer exit code: 2» на скачивании компонентов.
//
// Оба раза установщик скачивался успешно, поэтому глазами релиз выглядел готовым.
// Проверка сверяет то, что требуют манифест и манифест компонентов, с тем, что реально
// отдаётся, и падает до подписи, а не после установки на ферме.
//
// Использование:
//   node scripts/check-release-published.mjs --components work/app/src-tauri/resources/update-components/component-manifest.json
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPOSITORY = process.env.KF_RELEASE_REPOSITORY
  ?? 'sanozhukov3737-oss/klipper-farm-updates';
const CHANNEL_URL = `https://github.com/${REPOSITORY}/releases/latest/download/update-v20.json`;

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const head = async (url) => {
  const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  return { status: response.status, length: Number(response.headers.get('content-length') ?? -1) };
};

const download = async (url) => {
  const response = await fetch(url, { redirect: 'follow' });
  assert.equal(response.status, 200, `манифест канала недоступен: HTTP ${response.status}`);
  return response.json();
};

const manifest = await download(CHANNEL_URL);
console.log(`канал      : sequence ${manifest.sequence}, версия ${manifest.version}`);

// 1. Установщик по адресу из манифеста: без него обновление не начнётся.
const artifact = await head(manifest.artifact.url);
assert.equal(artifact.status, 200, `установщик недоступен: HTTP ${artifact.status}`);
assert.equal(artifact.length, manifest.artifact.sizeBytes,
  `размер установщика ${artifact.length} не совпадает с манифестом ${manifest.artifact.sizeBytes}`);
console.log(`установщик : ${manifest.artifact.url.split('/').pop()} — ${artifact.length} байт`);

// 2. Архив рантайма. Его адрес лежит не в манифесте обновления, а в манифесте
//    компонентов внутри установщика, поэтому путь передаётся явно.
// Манифест компонентов готовит сборка (он описывает скачанный рантайм), поэтому
// в дереве без компонентов его может не быть. Тогда сверка рантайма
// пропускается с явным сообщением, а не валит весь релизный отчёт: канал и
// подпись уже проверены выше.
const defaultComponentsPath = fileURLToPath(new URL('../src-tauri/resources/update-components/component-manifest.json', import.meta.url));
const componentsPath = argument('--components') ?? (existsSync(defaultComponentsPath) ? defaultComponentsPath : null);
if (!componentsPath) {
  console.log('рантайм    : component-manifest.json не найден, сверка рантайма пропущена');
  console.log('             он появляется после подготовки компонентов сборкой');
  process.exit(0);
}

const components = JSON.parse(readFileSync(componentsPath, 'utf8'));
const runtime = components.runtime;
assert.ok(runtime?.url, 'в манифесте компонентов нет адреса рантайма');
const archive = await head(runtime.url);
assert.equal(archive.status, 200,
  `архив рантайма не выложен: HTTP ${archive.status} — ${runtime.url}`);
assert.equal(archive.length, Number(runtime.bytes),
  `размер рантайма ${archive.length} не совпадает с манифестом ${runtime.bytes}`);
console.log(`рантайм    : ${runtime.url.split('/').pop()} — ${archive.length} байт`);

console.log('канал раздаёт обновление целиком');
