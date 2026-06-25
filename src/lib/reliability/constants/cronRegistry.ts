// Known cron / worker jobs for platform reliability monitoring

export interface CronJobDefinition {
  id: string;
  label: string;
  schedule: string;
  source: 'learning' | 'sync' | 'scheduler' | 'worker';
  /** DB job_name or label to match against run logs */
  matchKeys: string[];
}

export const CRON_REGISTRY: CronJobDefinition[] = [
  {
    id: 'market-warmup',
    label: 'Market Data Warmup',
    schedule: '09:20 IST weekdays',
    source: 'scheduler',
    matchKeys: ['warmup', 'market-warmup'],
  },
  {
    id: 'intraday-refresh',
    label: 'Intraday Candle Refresh',
    schedule: 'Every 10m (market hours)',
    source: 'scheduler',
    matchKeys: ['intraday', 'candle-refresh'],
  },
  {
    id: 'post-close',
    label: 'Post-Close Sync',
    schedule: '15:35 IST weekdays',
    source: 'scheduler',
    matchKeys: ['post-close', 'post_close'],
  },
  {
    id: 'daily-scan-am',
    label: 'Morning Signal Scan',
    schedule: '08:30 IST',
    source: 'scheduler',
    matchKeys: ['daily-scan', 'signal-scan'],
  },
  {
    id: 'daily-scan-pm',
    label: 'Afternoon Signal Scan',
    schedule: '16:30 IST',
    source: 'scheduler',
    matchKeys: ['daily-scan-pm', 'signal-scan-pm'],
  },
  {
    id: 'nightly-backtest',
    label: 'Nightly Backtest',
    schedule: '19:00 IST',
    source: 'scheduler',
    matchKeys: ['nightly-backtest', 'backtest'],
  },
  {
    id: 'midnight-maintenance',
    label: 'Midnight Maintenance',
    schedule: '00:00 IST',
    source: 'scheduler',
    matchKeys: ['midnight', 'maintenance'],
  },
  {
    id: 'feed-health-retention',
    label: 'Feed Health Retention',
    schedule: '02:30 IST daily',
    source: 'worker',
    matchKeys: ['feed-health', 'retention'],
  },
  {
    id: 'news-ingestion',
    label: 'News Ingestion',
    schedule: 'Continuous / scheduled',
    source: 'worker',
    matchKeys: ['news', 'news-ingestion', 'news_pipeline'],
  },
  {
    id: 'manipulation-scan',
    label: 'Manipulation Scan',
    schedule: '18:30 IST daily',
    source: 'learning',
    matchKeys: ['manipulation', 'manipulation-scan'],
  },
  {
    id: 'learning-scheduler',
    label: 'Learning / Calibration',
    schedule: '20:30 IST daily',
    source: 'learning',
    matchKeys: ['calibration', 'learning', 'evaluate', 'feedback'],
  },
  {
    id: 'rescore',
    label: 'Signal Rescore',
    schedule: 'On schedule',
    source: 'scheduler',
    matchKeys: ['rescore', 're-score'],
  },
];
