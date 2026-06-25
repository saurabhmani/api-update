import StrategyDetailClient from './StrategyDetailClient';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function StrategyDetailPage({ params }: Props) {
  const { id } = await params;
  return <StrategyDetailClient strategyId={id} />;
}
