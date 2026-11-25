/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchImageViaScrapeDo, needsScrapeDoForImage, sniffImageType } from '../../src/services/scrapedo-images';
import { createImageUploader } from '../../src/services/shopping-images';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
const HTML = Buffer.from('<!DOCTYPE html><html><body><p></p></body></html>');
const CF = 'https://cdn.mafrservices.com/pim-content/UAE/media/product/1840543/1790060400/1840543_main.jpg';
const env = { SCRAPE_DO_TOKEN: 'tok' } as NodeJS.ProcessEnv;

describe('Carrefour images through Scrape.do', () => {
  test('only listed CDN hosts go through Scrape.do, and only with a token', () => {
    assert.equal(needsScrapeDoForImage(CF, env), true);
    assert.equal(needsScrapeDoForImage(CF, {}), false);
    assert.equal(needsScrapeDoForImage('https://m.media-amazon.com/images/I/x.jpg', env), false);
    assert.equal(needsScrapeDoForImage('https://img.other.test/x.jpg', { ...env, SCRAPE_DO_IMAGE_HOSTS: 'img.other.test' }), true);
  });

  test('magic bytes decide the type; an HTML placeholder is not an image', () => {
    assert.equal(sniffImageType(JPEG), 'image/jpeg');
    assert.equal(sniffImageType(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.alloc(20)])), 'image/avif');
    assert.equal(sniffImageType(HTML), null);
  });

  test('escalates past an HTML placeholder to the next option; 404 is final', async () => {
    const calls: string[] = [];
    const get = async (u: string) => { calls.push(u); return calls.length === 1 ? { status: 200, data: HTML, headers: { 'scrape.do-request-cost': '1' } } : { status: 200, data: JPEG, headers: { 'scrape.do-request-cost': '10' } }; };
    const r = await fetchImageViaScrapeDo(CF, get, env);
    assert.equal(r.contentType, 'image/jpeg');
    assert.equal(calls.length, 2);
    assert.match(calls[1], /geoCode=ae/);
    assert.match(calls[0], /token=tok&url=https%3A%2F%2Fcdn\.mafrservices\.com/);

    await assert.rejects(fetchImageViaScrapeDo(CF, async () => ({ status: 404, data: HTML, headers: {} }), env), (e: any) => e.response?.status === 404);
    await assert.rejects(fetchImageViaScrapeDo(CF, async () => ({ status: 200, data: HTML, headers: {} }), env), /Not an image via Scrape\.do/);
  });

  test('uploader: listed hosts via Scrape.do then S3; every other host downloads directly', async () => {
    const log: string[] = [];
    const up = createImageUploader({
      env,
      direct: async u => { log.push(`direct ${u}`); return 'https://cdn.peppy.test/a.jpg'; },
      viaScrapeDo: async u => { log.push(`scrapedo ${u}`); return { body: JPEG, contentType: 'image/jpeg' }; },
      upload: async (_b, type, folder) => { log.push(`s3 ${type} ${folder}`); return 'https://cdn.peppy.test/b.jpg'; },
    });
    assert.equal(await up(CF, 'products/images'), 'https://cdn.peppy.test/b.jpg');
    assert.equal(await up('https://m.media-amazon.com/x.jpg', 'products/images'), 'https://cdn.peppy.test/a.jpg');
    assert.deepEqual(log, [`scrapedo ${CF}`, 's3 image/jpeg products/images', 'direct https://m.media-amazon.com/x.jpg']);
  });
});
