'use client'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

export default function StoresPage() {
  const router = useRouter()
  useEffect(() => { router.replace('/settings') }, [])
  return null
}
