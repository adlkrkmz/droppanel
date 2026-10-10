import PublicMarketingLayout from '@/components/public/PublicMarketingLayout'

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <PublicMarketingLayout variant="prose">{children}</PublicMarketingLayout>
}
