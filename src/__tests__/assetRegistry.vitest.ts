import { describe, expect, it } from 'vitest';
import {
  getAssetById,
  listAssets,
  resolveAssetForSymbol,
  DEFAULT_NSE_EQUITY_ASSET,
  registerAsset,
} from '@/lib/platform/assetRegistry';

describe('asset registry', () => {
  it('resolves NSE equity with Product A defaults', () => {
    const asset = resolveAssetForSymbol('RELIANCE', 'NSE', 'equity');
    expect(asset.assetClass).toBe('equity');
    expect(asset.currency).toBe('INR');
    expect(asset.tickSize).toBe(0.05);
    expect(asset.timezone).toBe('Asia/Kolkata');
  });

  it('lists all supported asset classes', () => {
    const classes = new Set(listAssets().map((a) => a.assetClass));
    expect(classes.has('equity')).toBe(true);
    expect(classes.has('crypto')).toBe(true);
    expect(classes.has('forex')).toBe(true);
    expect(classes.has('options')).toBe(true);
  });

  it('marks options as metadata-only', () => {
    const opt = getAssetById('NSE:NIFTY_OPT');
    expect(opt?.metadataOnly).toBe(true);
  });

  it('allows registering custom assets', () => {
    registerAsset({ ...DEFAULT_NSE_EQUITY_ASSET, assetId: 'TEST:FOO', symbol: 'FOO' });
    expect(getAssetById('TEST:FOO')?.symbol).toBe('FOO');
  });
});
