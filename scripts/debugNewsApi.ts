/* eslint-disable no-console */
import 'tsconfig-paths/register';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });

const KEY = process.env.NEWSAPI_KEY || process.env.NEWSAPI_API_KEY;
if (!KEY) { console.log('no key'); process.exit(0); }

async function probe(label: string, url: string) {
  console.log(`\n── ${label} ──`);
  const res = await fetch(url, { headers: { 'X-Api-Key': KEY! } });
  console.log('status:', res.status);
  const body = await res.json().catch(() => null);
  if (body) {
    console.log('shape:', { status: body.status, code: body.code, message: body.message, totalResults: body.totalResults, articles: body.articles?.length });
    if (body.articles?.length) {
      console.log('first title:', body.articles[0].title);
    }
  }
}

(async () => {
  await probe('top-headlines country=in&category=business',
    'https://newsapi.org/v2/top-headlines?country=in&category=business&pageSize=20');
  await probe('top-headlines country=in (no category)',
    'https://newsapi.org/v2/top-headlines?country=in&pageSize=20');
  await probe('top-headlines category=business (no country)',
    'https://newsapi.org/v2/top-headlines?category=business&pageSize=20');
  await probe('everything q="NSE OR BSE OR Sensex"',
    'https://newsapi.org/v2/everything?q=NSE+OR+BSE+OR+Sensex&language=en&pageSize=20&sortBy=publishedAt');
  process.exit(0);
})();
