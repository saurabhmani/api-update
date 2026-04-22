'use client';

import { Newspaper } from 'lucide-react';
import { Card }      from '@/components/ui';
import { clsx }      from '@/lib/utils';
import type { NewsItem } from '../types';
import s from '../StockDashboard.module.scss';

interface Props {
  news: NewsItem[];
  symbol: string;
}

export default function NewsTab({ news, symbol }: Props) {
  if (news.length === 0) {
    return (
      <div className={s.panel}>
        <div className={s.empty}>
          <div className={s.emptyIcon}><Newspaper size={22} /></div>
          <div className={s.emptyTitle}>No news for {symbol}</div>
          <div className={s.emptyDesc}>
            News is aggregated from NSE disclosures and financial news APIs.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.panel}>
      <Card title="Latest News" flush>
        {news.map(item => (
          <a
            key={item.id}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className={s.newsItem}
          >
            <div className={s.newsIcon}><Newspaper size={16} /></div>
            <div className={s.newsBody}>
              <div className={s.newsTitle}>{item.title}</div>
              <div className={s.newsMeta}>
                <span>{item.source}</span>
                <span>&middot;</span>
                <span>
                  {new Date(item.published_at).toLocaleDateString('en-IN', {
                    day: '2-digit', month: 'short', year: 'numeric',
                  })}
                </span>
                {item.sentiment && (
                  <span className={clsx(s.sentimentChip, s[`sentimentChip--${item.sentiment}`])}>
                    {item.sentiment}
                  </span>
                )}
              </div>
            </div>
          </a>
        ))}
      </Card>
    </div>
  );
}
