'use client';

import { useMemo, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { StrategyHubGrid } from '@/components/strategies/StrategyHubGrid';
import { StrategyCard } from '@/components/strategies/StrategyCard';
import { DeployedStrategiesSection } from '@/components/strategies/DeployedStrategiesSection';
import { StrategyManagementDashboard } from '@/components/strategies/StrategyManagementDashboard';
import { StrategyOperationsPanel } from '@/components/strategies/StrategyOperationsPanel';
import { StrategyAiInsightsPanel } from '@/components/strategies/StrategyAiInsightsPanel';
import { StrategyPortfolioPanel } from '@/components/strategies/StrategyPortfolioPanel';
import { BulkActionToolbar } from '@/components/strategies/BulkActionToolbar';
import { ModeActivityPanel } from '@/components/strategies/ModeActivityPanel';
import { useStrategyHub } from '@/hooks/useStrategyHub';
import { useStrategyManagement } from '@/hooks/useStrategyManagement';
import { useAuth } from '@/hooks/useAuth';
import { ChevronDown, ChevronUp } from 'lucide-react';
import styles from './strategies.module.scss';

export default function StrategyHubPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { data: management } = useStrategyManagement({ limit: 12 });
  const canManage = isAdmin && (management?.canManage ?? false);

  const [category, setCategory] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<string | null>(null);
  const [direction, setDirection] = useState<string | null>(null);
  const [marketType, setMarketType] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [risk, setRisk] = useState<string | null>(null);
  const [paperReadyOnly, setPaperReadyOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [hubView, setHubView] = useState<'strategies' | 'operations' | 'ai' | 'portfolio'>('strategies');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);

  const { data } = useStrategyHub({
    category,
    paperReadyOnly,
    timeframe,
    direction,
    marketType,
    status,
    risk,
    window: '90D',
  });

  const visibleStrategies = data?.strategies ?? [];
  const hasFilters = Boolean(category || timeframe || direction || marketType || status || risk || paperReadyOnly);
  const showFeatured = Boolean(data && data.featured.length > 0 && !hasFilters);
  const featuredIds = useMemo(
    () => (showFeatured ? data!.featured.map((s) => s.strategyId) : []),
    [showFeatured, data],
  );

  const categories = useMemo(
    () => (data?.categories ?? []).map((c) => ({ id: c.id, label: c.label })),
    [data?.categories],
  );

  const resetFilters = () => {
    setCategory(null);
    setTimeframe(null);
    setDirection(null);
    setMarketType(null);
    setStatus(null);
    setRisk(null);
    setPaperReadyOnly(false);
  };

  const toggleSelect = (strategyId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(strategyId)) next.delete(strategyId);
      else next.add(strategyId);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedIds(new Set(visibleStrategies.map((s) => s.strategyId)));
  };

  const clearSelection = () => setSelectedIds(new Set());

  return (
    <AppShell title="Strategy Hub">
      <div className={`page ${styles.strategyHub}`}>
        <div className={styles.hubHeader}>
          <div>
            <h1 className={styles.hubTitle}>Strategy Hub</h1>
            <p className={styles.hubSubtitle}>
              Manage strategies, deployments, and performance from one place.
            </p>
          </div>
        </div>

        <nav className={styles.hubNav} aria-label="Strategy Hub sections">
          {([
            ['strategies', 'Strategies'],
            ['operations', 'Operations'],
            ['ai', 'AI Insights'],
            ['portfolio', 'Portfolio'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={hubView === id ? styles.hubNavActive : styles.hubNavItem}
              onClick={() => setHubView(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        {hubView === 'operations' && <StrategyOperationsPanel canManage={canManage} />}
        {hubView === 'ai' && <StrategyAiInsightsPanel canManage={canManage} />}
        {hubView === 'portfolio' && <StrategyPortfolioPanel canManage={canManage} />}

        {hubView === 'strategies' && (
          <>
            <StrategyManagementDashboard />
            <DeployedStrategiesSection />

            {canManage && selectedIds.size > 0 && (
              <BulkActionToolbar
                strategies={visibleStrategies}
                selectedIds={selectedIds}
                onSelectAll={selectAllVisible}
                onClearSelection={clearSelection}
                categories={categories}
              />
            )}

            {showFeatured && (
              <section className={styles.featuredSection}>
                <h2 className={styles.sectionTitle}>Featured</h2>
                <div className={styles.featuredRow}>
                  {data!.featured.slice(0, 4).map((s) => (
                    <StrategyCard
                      key={s.strategyId}
                      strategy={s}
                      featured
                      selectable={canManage}
                      selected={selectedIds.has(s.strategyId)}
                      onToggleSelect={toggleSelect}
                      canManage={canManage}
                    />
                  ))}
                </div>
              </section>
            )}

            <section className={styles.catalogSection}>
              <div className={styles.catalogHeader}>
                <h2 className={styles.sectionTitle}>
                  All Strategies
                  {data?.total != null && (
                    <span className={styles.sectionCount}>{visibleStrategies.length} shown</span>
                  )}
                </h2>
                <button
                  type="button"
                  className={styles.filterToggle}
                  onClick={() => setFiltersOpen((v) => !v)}
                >
                  Filters
                  {hasFilters && <span className={styles.filterBadge}>On</span>}
                  {filtersOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
              </div>

              <div className={styles.filters}>
                <span className={styles.filterLabel}>Category</span>
                <button
                  type="button"
                  className={category === null ? styles.filterChipActive : styles.filterChip}
                  onClick={() => setCategory(null)}
                >
                  All
                </button>
                {(data?.categories ?? []).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={category === c.id ? styles.filterChipActive : styles.filterChip}
                    onClick={() => setCategory(c.id)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              {filtersOpen && (
                <div className={styles.filterPanel}>
                  <div className={styles.filterGroup}>
                    <span className={styles.filterLabel}>Timeframe</span>
                    {[
                      { label: 'Intraday', value: 'intraday' },
                      { label: 'Positional', value: 'positional' },
                    ].map((f) => (
                      <button
                        key={f.value}
                        type="button"
                        className={timeframe === f.value ? styles.filterChipActive : styles.filterChip}
                        onClick={() => setTimeframe(timeframe === f.value ? null : f.value)}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                  <div className={styles.filterGroup}>
                    <span className={styles.filterLabel}>Market</span>
                    {['Equity', 'Options'].map((f) => (
                      <button
                        key={f}
                        type="button"
                        className={marketType === f ? styles.filterChipActive : styles.filterChip}
                        onClick={() => setMarketType(marketType === f ? null : f)}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                  <div className={styles.filterGroup}>
                    <span className={styles.filterLabel}>Direction</span>
                    {[
                      { label: 'Long', value: 'BUY' },
                      { label: 'Short', value: 'SELL' },
                      { label: 'Both', value: 'BOTH' },
                    ].map((f) => (
                      <button
                        key={f.value}
                        type="button"
                        className={direction === f.value ? styles.filterChipActive : styles.filterChip}
                        onClick={() => setDirection(direction === f.value ? null : f.value)}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                  <div className={styles.filterGroup}>
                    <span className={styles.filterLabel}>Status</span>
                    {['Active', 'Backtested', 'Inactive', 'Premium'].map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={status === s ? styles.filterChipActive : styles.filterChip}
                        onClick={() => setStatus(status === s ? null : s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <div className={styles.filterGroup}>
                    <span className={styles.filterLabel}>Risk</span>
                    {[
                      { label: 'Conservative', value: 'conservative' },
                      { label: 'Moderate', value: 'moderate' },
                      { label: 'Mod-High', value: 'moderate_high' },
                      { label: 'High', value: 'high' },
                    ].map((r) => (
                      <button
                        key={r.value}
                        type="button"
                        className={risk === r.value ? styles.filterChipActive : styles.filterChip}
                        onClick={() => setRisk(risk === r.value ? null : r.value)}
                      >
                        {r.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={paperReadyOnly ? styles.filterChipActive : styles.filterChip}
                      onClick={() => setPaperReadyOnly((v) => !v)}
                    >
                      Paper Ready
                    </button>
                  </div>
                  {hasFilters && (
                    <button type="button" className={styles.filterReset} onClick={resetFilters}>
                      Clear all filters
                    </button>
                  )}
                </div>
              )}

              <StrategyHubGrid
                category={category}
                paperReadyOnly={paperReadyOnly}
                timeframe={timeframe}
                direction={direction}
                marketType={marketType}
                status={status}
                risk={risk}
                excludeIds={featuredIds}
                selectable={canManage}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                canManage={canManage}
              />
            </section>

            {canManage && (
              <section className={styles.collapsibleSection}>
                <button
                  type="button"
                  className={styles.collapsibleHeader}
                  onClick={() => setActivityOpen((v) => !v)}
                >
                  <span>Mode Change History</span>
                  {activityOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </button>
                {activityOpen && (
                  <div className={styles.collapsibleBody}>
                    <ModeActivityPanel limit={12} />
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
