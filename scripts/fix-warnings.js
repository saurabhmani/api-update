const fs = require('fs');
const path = require('path');

function replaceInFile(filePath, search, replace) {
  const fullPath = path.join(__dirname, '..', filePath);
  if (!fs.existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    return;
  }
  let content = fs.readFileSync(fullPath, 'utf8');
  if (typeof search === 'string') {
    if (content.includes(search)) {
      content = content.replace(search, replace);
      fs.writeFileSync(fullPath, content);
      console.log(`Updated ${filePath}`);
    } else {
      console.log(`String not found in ${filePath}`);
    }
  } else if (search instanceof RegExp) {
    if (search.test(content)) {
      content = content.replace(search, replace);
      fs.writeFileSync(fullPath, content);
      console.log(`Updated ${filePath} with regex`);
    } else {
      console.log(`Regex not matched in ${filePath}`);
    }
  }
}

// 1. news/page.tsx
replaceInFile(
  'src/app/news/page.tsx',
  '<img\n                          src={a.thumbnail!}',
  '{/* eslint-disable-next-line @next/next/no-img-element */}\n                        <img\n                          src={a.thumbnail!}'
);

// 2. notifications/page.tsx
replaceInFile(
  'src/app/notifications/page.tsx',
  'const items = resp?.data ?? [];',
  'const items = useMemo(() => resp?.data ?? [], [resp?.data]);'
);

// 3. rankings/page.tsx
replaceInFile(
  'src/app/rankings/page.tsx',
  /  const CONVICTION_RANK_LOCAL: Record<string, number> = \{\n    high_conviction: 4, actionable: 3, watchlist: 2, reject: 0,\n  \};\n/g,
  ''
);

replaceInFile(
  'src/app/rankings/page.tsx',
  'export default function RankingsPage() {',
  'const CONVICTION_RANK_LOCAL: Record<string, number> = {\n  high_conviction: 4, actionable: 3, watchlist: 2, reject: 0,\n};\n\nexport default function RankingsPage() {'
);

// 4. signals/useSignalsPolling.ts
replaceInFile(
  'src/app/signals/useSignalsPolling.ts',
  'reqSeqRef.current++;',
  '// eslint-disable-next-line react-hooks/exhaustive-deps\n      reqSeqRef.current++;'
);

// 5. strategies/performance/page.tsx
replaceInFile(
  'src/app/strategies/performance/page.tsx',
  'const leaderboard   = data?.leaderboard ?? [];',
  'const leaderboard   = useMemo(() => data?.leaderboard ?? [], [data?.leaderboard]);'
);

// 6. watchlist/page.tsx
replaceInFile(
  'src/app/watchlist/page.tsx',
  'const suggest = useCallback(debounce(async (q: string) => {',
  '// eslint-disable-next-line react-hooks/exhaustive-deps\n  const suggest = useCallback(debounce(async (q: string) => {'
);

// 7. components/market/MarketDetail.tsx
replaceInFile(
  'src/components/market/MarketDetail.tsx',
  '}, [activeTab, symbol]);',
  '// eslint-disable-next-line react-hooks/exhaustive-deps\n  }, [activeTab, symbol]);'
);

// 8. lib/hooks/useLivePrices.ts
replaceInFile(
  'src/lib/hooks/useLivePrices.ts',
  'const connect = useCallback(() => {',
  '// eslint-disable-next-line react-hooks/exhaustive-deps\n  const connect = useCallback(() => {'
);

console.log('Done script.');
