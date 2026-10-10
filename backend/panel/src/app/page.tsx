import type { Metadata } from 'next'

import ListJetGoHomePage from '@/components/public/homepage/ListJetGoHomePage'

export const metadata: Metadata = {
  title: 'ListJetGo — eBay operasyonunu tek merkezden yönet',
  description: 'Stok, fiyat, sipariş ve ürün keşfi için akıllı kontrol paneli.',
}

export default function RootPage() {
  return <ListJetGoHomePage />
}
