// Known cron / worker jobs for platform reliability monitoring

export interface CronJobDefinition {
  id: string;
  label: string;
  schedule: string;
  source: 'learning' | 'sync' | 'scheduler' | 'worker';
  /** DB job_name or label to match against run logs */
  matchKeys: string[];
  /**
   * Phase 13 — broker relation for this job.
   * system_owned_ingestion requires SYSTEM_MARKET_DATA_USER_ID.
   */
  brokerClass?: 'broker_neutral_db' | 'system_owned_ingestion' | 'user_specific_broker';
}

export const CRON_REGISTRY: CronJobDefinition[] = [
  {
    id: 'market-warmup',
    label: 'Market Data Warmup',
    schedule: '09:20 IST weekdays',
    source: 'scheduler',
    matchKeys: ['warmup', 'market-warmup'],
    brokerClass: 'system_owned_ingestion',
  },
  {
    id: 'intraday-refresh',
    label: 'Intraday Candle Refresh',
    schedule: 'Every 10m (market hours)',
    source: 'scheduler',
    matchKeys: ['intraday', 'candle-refresh'],
    brokerClass: 'system_owned_ingestion',
  },
  {
    id: 'post-close',
    label: 'Post-Close Sync',
    schedule: '15:35 IST weekdays',
    source: 'scheduler',
    matchKeys: ['post-close', 'post_close'],
    brokerClass: 'system_owned_ingestion',
  },
  {
    id: 'daily-scan-am',
    label: 'Morning Signal Scan',
    schedule: '08:30 IST',
    source: 'scheduler',
    matchKeys: ['daily-scan', 'signal-scan'],
    brokerClass: 'broker_neutral_db',
  },
  {
    id: 'daily-scan-pm',
    label: 'Afternoon Signal Scan',
    schedule: '16:30 IST',
    source: 'scheduler',
    matchKeys: ['daily-scan-pm', 'signal-scan-pm'],
    brokerClass: 'broker_neutral_db',
  },
  {
    id: 'candle-daily-update',
    label: 'Evening Candle Update (Kite)',
    schedule: '~16:00 IST',
    source: 'scheduler',
    matchKeys: ['candle-daily', 'evening-update'],
    brokerClass: 'system_owned_ingestion',
  },
  {
    id: 'eod-bhavcopy',
    label: 'NSE Bhavcopy EOD',
    schedule: '19:30 IST',
    source: 'scheduler',
    matchKeys: ['eod', 'bhavcopy'],
    brokerClass: 'system_owned_ingestion',
  },
  {
    id: 'nightly-backtest',
    label: 'Nightly Backtest',
    schedule: '19:00 IST',
    source: 'scheduler',
    matchKeys: ['nightly-backtest', 'backtest'],
    brokerClass: 'broker_neutral_db',
  },
  {
    id: 'midnight-maintenance',
    label: 'Midnight Maintenance',
    schedule: '00:00 IST',
    source: 'scheduler',
    matchKeys: ['midnight', 'maintenance'],
    brokerClass: 'broker_neutral_db',
  },
  {
    id: 'feed-health-retention',
    label: 'Feed Health Retention',
    schedule: '02:30 IST daily',
    source: 'worker',
    matchKeys: ['feed-health', 'retention'],
    brokerClass: 'broker_neutral_db',
  },
  {
    id: 'news-ingestion',
    label: 'News Ingestion',
    schedule: 'Continuous / scheduled',
    source: 'worker',
    matchKeys: ['news', 'news-ingestion', 'news_pipeline'],
    brokerClass: 'broker_neutral_db',
  },
  {
    id: 'manipulation-scan',
    label: 'Manipulation Scan',
    schedule: '18:30 IST daily',
    source: 'learning',
    matchKeys: ['manipulation', 'manipulation-scan'],
    brokerClass: 'broker_neutral_db',
  },
  {
    id: 'learning-scheduler',
    label: 'Learning / Calibration',
    schedule: '20:30 IST daily',
    source: 'learning',
    matchKeys: ['calibration', 'learning', 'evaluate', 'feedback'],
    brokerClass: 'broker_neutral_db',
  },
  {
    id: 'rescore',
    label: 'Signal Rescore',
    schedule: 'On schedule',
    source: 'scheduler',
    matchKeys: ['rescore', 're-score'],
    brokerClass: 'system_owned_ingestion',
  },
];
