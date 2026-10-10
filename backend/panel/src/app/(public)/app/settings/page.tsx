"use client"

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { fetchAuthMe, fetchLoginMethods, postChangePassword, type UserPublic } from "@/lib/userAuthClient"
import {
  fetchAppSettings,
  fetchAppSettingsPolicies,
  fetchAppStores,
  fetchAppEbayStatus,
  startAppEbayConnect,
  startAppEbayReconnect,
  removeAppStore,
  fetchAppMailboxStatus,
  startAppMailboxConnect,
  syncAppMailbox,
  disconnectAppMailbox,
  saveAppSettingsAddress,
  saveAppSettingsMarkup,
  saveAppSettingsPolicies,
  saveAppSettingsPricing,
  saveAppWarehouseBanner,
  type AppStoreSettings,
  type AppStoreSummary,
  type AppMailboxAccount,
} from "@/lib/userAppClient"
import type { AppPolicyOption } from "@/lib/userAppTypes"
import {
  emptyPricingRangeRow,
  rangesToFormRows,
  validatePricingRangeRows,
  type PricingRangeRow,
} from "@/lib/pricingRanges"
import { InfoTooltip } from "@/components/ui/InfoTooltip"
import { NoStoreEmptyState } from "@/components/app/NoStoreEmptyState"
import { AppHelpBox } from "@/components/app/AppHelpBox"
import { ConfirmModal } from "@/components/ConfirmModal"
import { useFocusRefetch } from "@/components/app/useFocusRefetch"
import {
  adoptStoreSelection,
  parseUrlStoreId,
  storeCodeForId,
  useAppStoreSelection,
} from "@/lib/appStoreSelection"

const COUNTRY_OPTIONS = [
  { value: "US", label: "United States" },
  { value: "GB", label: "United Kingdom" },
  { value: "DE", label: "Germany" },
  { value: "FR", label: "France" },
  { value: "AU", label: "Australia" },
  { value: "CA", label: "Canada" },
  { value: "TR", label: "Turkey" },
  { value: "IT", label: "Italy" },
  { value: "ES", label: "Spain" },
  { value: "NL", label: "Netherlands" },
  { value: "IE", label: "Ireland" },
  { value: "AT", label: "Austria" },
  { value: "BE", label: "Belgium" },
  { value: "PL", label: "Poland" },
  { value: "SE", label: "Sweden" },
  { value: "CH", label: "Switzerland" },
  { value: "JP", label: "Japan" },
  { value: "MX", label: "Mexico" },
  { value: "BR", label: "Brazil" },
  { value: "IN", label: "India" },
  { value: "SG", label: "Singapore" },
  { value: "HK", label: "Hong Kong" },
] as const

const ISO2_SET = new Set<string>(COUNTRY_OPTIONS.map(c => c.value))

type AddressForm = {
  firstName:           string
  lastName:            string
  company:             string
  address1:            string
  address2:            string
  city:                string
  state:               string
  zip:                 string
  country:             string
  countryOrRegion:     string
  cityState:           string
  registrationCountry: string
  merchantLocationKey:   string
}

const emptyAddressForm = (): AddressForm => ({
  firstName:           "",
  lastName:            "",
  company:             "",
  address1:            "",
  address2:            "",
  city:                "",
  state:               "",
  zip:                 "",
  country:             "",
  countryOrRegion:     "",
  cityState:           "",
  registrationCountry: "",
  merchantLocationKey: "",
})

type DirtySections = {
  markup: boolean
  pricing: boolean
  address: boolean
  policies: boolean
  banner: boolean
}

const CLEAN_DIRTY: DirtySections = {
  markup: false,
  pricing: false,
  address: false,
  policies: false,
  banner: false,
}

function settingsToForms(s: AppStoreSettings) {
  const addr = s.address
  // Keep form country state as ISO2 so the select value matches React state.
  // Previously select used toIso2Country("") → "US" while state stayed "",
  // which made Save Address fail client required-field validation.
  const country = toIso2Country(addr?.country ?? s.countryOrRegion ?? "")
  const registrationCountry = toIso2Country(s.registrationCountry ?? "", country)
  return {
    markupPercent: String(s.markupPercent),
    pricingMode: s.pricingMode,
    percentageNetProfitPercent: String(s.percentageNetProfitPercent),
    tieredProfitOverrides: rangesToFormRows(s.tieredProfitOverrides ?? []),
    address: {
      firstName:           addr?.firstName ?? "",
      lastName:            addr?.lastName ?? "",
      company:             addr?.company ?? "",
      address1:            addr?.address1 ?? "",
      address2:            addr?.address2 ?? "",
      city:                addr?.city ?? "",
      state:               addr?.state ?? "",
      zip:                 addr?.zip ?? "",
      country,
      countryOrRegion:     country,
      cityState:           s.cityState ?? "",
      registrationCountry,
      merchantLocationKey: s.merchantLocationKey ?? "",
    },
    fulfillmentPolicyId: s.fulfillmentPolicyId ?? "",
    paymentPolicyId:     s.paymentPolicyId ?? "",
    returnPolicyId:      s.returnPolicyId ?? "",
    warehouseBanner:     s.warehouseShippingBannerEnabled,
  }
}

export default function AppSettingsPage() {
  const router = useRouter()
  const { selectedStoreId, setSelectedStoreId, isStoreSelectionReady } = useAppStoreSelection()
  const selectedStoreIdRef = useRef(selectedStoreId)
  selectedStoreIdRef.current = selectedStoreId
  const [user, setUser] = useState<UserPublic | null>(null)
  const [stores, setStores] = useState<AppStoreSummary[]>([])
  const [storeCode, setStoreCode] = useState("")
  const [settings, setSettings] = useState<AppStoreSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [dirty, setDirty] = useState<DirtySections>(CLEAN_DIRTY)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const isFormDirty = dirty.markup || dirty.pricing || dirty.address || dirty.policies || dirty.banner

  const [markupPercent, setMarkupPercent] = useState("")
  const [pricingMode, setPricingMode] = useState<AppStoreSettings["pricingMode"]>("PERCENTAGE_NET_PROFIT")
  const [percentageNetProfitPercent, setPercentageNetProfitPercent] = useState("")
  const [tieredProfitRows, setTieredProfitRows] = useState<PricingRangeRow[]>([])
  const [addressForm, setAddressForm] = useState<AddressForm>(emptyAddressForm)
  const [fulfillmentPolicyId, setFulfillmentPolicyId] = useState("")
  const [paymentPolicyId, setPaymentPolicyId] = useState("")
  const [returnPolicyId, setReturnPolicyId] = useState("")
  const [policyOptions, setPolicyOptions] = useState<{
    fulfillmentPolicies: AppPolicyOption[]
    paymentPolicies: AppPolicyOption[]
    returnPolicies: AppPolicyOption[]
  }>({ fulfillmentPolicies: [], paymentPolicies: [], returnPolicies: [] })
  const [warehouseBanner, setWarehouseBanner] = useState(false)
  const [ebayStatus, setEbayStatus] = useState<{ connected: boolean; stores: { storeCode: string; connected: boolean }[] } | null>(null)
  const [mailboxAccounts, setMailboxAccounts] = useState<AppMailboxAccount[]>([])
  const [mailboxBusyId, setMailboxBusyId] = useState<number | "connect" | null>(null)
  const [mailboxSyncMsg, setMailboxSyncMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
  const [mailboxDisconnectConfirm, setMailboxDisconnectConfirm] = useState<AppMailboxAccount | null>(null)

  const [savingMarkup, setSavingMarkup] = useState(false)
  const [savingPricing, setSavingPricing] = useState(false)
  const [savingAddress, setSavingAddress] = useState(false)
  const [savingPolicies, setSavingPolicies] = useState(false)
  const [savingBanner, setSavingBanner] = useState(false)

  const [markupMsg, setMarkupMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
  const [pricingMsg, setPricingMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
  const [addressMsg, setAddressMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
  const [policiesMsg, setPoliciesMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
  const [bannerMsg, setBannerMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
  const [storeMgmtMsg, setStoreMgmtMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
  const [reconnectBusyId, setReconnectBusyId] = useState<number | null>(null)
  const [removeConfirmId, setRemoveConfirmId] = useState<number | null>(null)
  const [removeBusyId, setRemoveBusyId] = useState<number | null>(null)
  const [removeAck, setRemoveAck] = useState(false)

  const applySettingsToForms = useCallback((s: AppStoreSettings, sectionDirty: DirtySections) => {
    const f = settingsToForms(s)
    if (!sectionDirty.markup) setMarkupPercent(f.markupPercent)
    if (!sectionDirty.pricing) {
      setPricingMode(f.pricingMode)
      setPercentageNetProfitPercent(f.percentageNetProfitPercent)
      setTieredProfitRows(f.tieredProfitOverrides)
    }
    if (!sectionDirty.address) setAddressForm(f.address)
    if (!sectionDirty.policies) {
      setFulfillmentPolicyId(f.fulfillmentPolicyId)
      setPaymentPolicyId(f.paymentPolicyId)
      setReturnPolicyId(f.returnPolicyId)
    }
    if (!sectionDirty.banner) setWarehouseBanner(f.warehouseBanner)
  }, [])

  const fetchSettingsData = useCallback(
    async (
      code: string,
      opts?: { silent?: boolean; sectionDirty?: DirtySections }
    ): Promise<boolean> => {
      if (!code) return false
      const silent = opts?.silent === true

      if (!silent) {
        setSettingsLoading(true)
        setError(null)
        setMarkupMsg(null)
        setAddressMsg(null)
        setPoliciesMsg(null)
        setBannerMsg(null)
      }

      const [result, policiesResult, mailboxResult] = await Promise.all([
        fetchAppSettings(code),
        fetchAppSettingsPolicies(code),
        fetchAppMailboxStatus(),
      ])

      if (!silent) {
        setSettingsLoading(false)
      }

      if (!result.ok) {
        if (result.status === 401) {
          router.replace("/app/login")
          return false
        }
        if (result.status === 403 && result.approvalStatus === "pending_approval") {
          router.replace("/pending-approval")
          return false
        }
        if (silent) {
          setError(prev => prev ?? result.error)
        } else {
          setError(result.error)
          setSettings(null)
        }
        return false
      }

      setSettings(result.data.settings)
      if (policiesResult.ok) {
        setPolicyOptions(policiesResult.data.policies)
        setPoliciesMsg(null)
      } else {
        setPoliciesMsg({ type: "err", text: policiesResult.error })
      }
      if (mailboxResult.ok) {
        setMailboxAccounts(mailboxResult.data.accounts)
      }
      const sectionDirty = opts?.sectionDirty ?? (silent ? dirtyRef.current : CLEAN_DIRTY)
      applySettingsToForms(result.data.settings, sectionDirty)
      return true
    },
    [router, applySettingsToForms]
  )

  const loadSettings = useCallback(
    async (code: string) => {
      await fetchSettingsData(code)
    },
    [fetchSettingsData]
  )

  const refreshSettings = useCallback(async () => {
    if (!storeCode) return
    if (savingMarkup || savingAddress || savingPolicies || savingBanner) return
    setRefreshing(true)
    const storesResult = await fetchAppStores()
    if (storesResult.ok) {
      setStores(storesResult.data.stores)
    }
    await fetchSettingsData(storeCode, { silent: true, sectionDirty: dirtyRef.current })
    setRefreshing(false)
  }, [storeCode, fetchSettingsData, savingMarkup, savingAddress, savingPolicies, savingBanner])

  useFocusRefetch(refreshSettings, { enabled: !loading && Boolean(storeCode) })

  const updateAddressForm = useCallback((updater: (f: AddressForm) => AddressForm) => {
    setAddressForm(updater)
    setDirty(prev => ({ ...prev, address: true }))
  }, [])

  const init = useCallback(async () => {
    setLoading(true)
    setError(null)

    const u = await fetchAuthMe()
    if (!u) {
      router.replace("/app/login")
      return
    }
    if (u.approvalStatus !== "active") {
      router.replace(u.approvalStatus === "pending_approval" ? "/pending-approval" : "/app/login")
      return
    }
    setUser(u)

    const storesResult = await fetchAppStores()
    if (!storesResult.ok) {
      if (storesResult.status === 401) {
        router.replace("/app/login")
        return
      }
      if (storesResult.status === 403 && storesResult.approvalStatus === "pending_approval") {
        router.replace("/pending-approval")
        return
      }
      setError(storesResult.error)
      setLoading(false)
      return
    }

    const list = storesResult.data.stores
    setStores(list)
    const [ebayResult, mailboxResult] = await Promise.all([
      fetchAppEbayStatus(),
      fetchAppMailboxStatus(),
    ])
    if (ebayResult.ok) setEbayStatus(ebayResult.data)
    if (mailboxResult.ok) setMailboxAccounts(mailboxResult.data.accounts)

    const params = new URLSearchParams(window.location.search)
    if (params.get("ebayReconnected") === "1") {
      setStoreMgmtMsg({ type: "ok", text: "eBay reconnect completed. Tokens were updated for the existing store." })
      params.delete("ebayReconnected")
      const qs = params.toString()
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""))
    }
    const ebayErr = params.get("ebayError")?.trim()
    if (ebayErr) {
      setStoreMgmtMsg({ type: "err", text: decodeURIComponent(ebayErr) })
      params.delete("ebayError")
      const qs = params.toString()
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""))
    }
    if (params.get("mailboxConnected") === "1") {
      setStoreMgmtMsg({ type: "ok", text: "Gmail mailbox connected to this workspace." })
      params.delete("mailboxConnected")
      const qs = params.toString()
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""))
    }
    const mailboxErr = params.get("mailboxError")?.trim()
    if (mailboxErr) {
      setStoreMgmtMsg({ type: "err", text: decodeURIComponent(mailboxErr) })
      params.delete("mailboxError")
      const qs = params.toString()
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""))
    }

    if (list.length === 0) {
      setLoading(false)
      return
    }

    const urlCode = params.get("storeCode")?.trim() ?? ""
    const adopted = adoptStoreSelection(list, {
      providerStoreId: selectedStoreIdRef.current,
      urlStoreId: parseUrlStoreId(params.get("storeId")),
      urlStoreCode: urlCode || null,
    })
    if (adopted.shouldWriteProvider && adopted.storeId != null) {
      setSelectedStoreId(adopted.storeId)
    }
    const validCode = storeCodeForId(list, adopted.storeId)
    setStoreCode(validCode)
    setLoading(false)
    await loadSettings(validCode)
  }, [router, loadSettings, setSelectedStoreId])

  useEffect(() => {
    if (!isStoreSelectionReady) return
    void init()
  }, [isStoreSelectionReady, init])

  useEffect(() => {
    if (!isStoreSelectionReady || loading || stores.length === 0) return
    if (selectedStoreId == null) return
    const code = storeCodeForId(stores, selectedStoreId)
    if (!code || code === storeCode) return
    setStoreCode(code)
    setDirty(CLEAN_DIRTY)
    void loadSettings(code)
    const url = new URL(window.location.href)
    url.searchParams.set("storeCode", code)
    window.history.replaceState(null, "", url.pathname + url.search)
  }, [selectedStoreId, stores, isStoreSelectionReady, loading, storeCode, loadSettings])

  function handleStoreChange(storeIdRaw: string) {
    const id = Number(storeIdRaw)
    const store = stores.find(s => s.storeId === id)
    if (!store) return
    setSelectedStoreId(id)
    setStoreCode(store.storeCode)
    setDirty(CLEAN_DIRTY)
    void loadSettings(store.storeCode)
    const url = new URL(window.location.href)
    url.searchParams.set("storeCode", store.storeCode)
    window.history.replaceState(null, "", url.pathname + url.search)
  }

  async function handleSaveMarkup() {
    const value = Number(markupPercent)
    if (!Number.isFinite(value) || value < 0 || value > 300) {
      setMarkupMsg({ type: "err", text: "Markup must be between 0 and 300." })
      return
    }
    setSavingMarkup(true)
    setMarkupMsg(null)
    const result = await saveAppSettingsMarkup(storeCode, value)
    setSavingMarkup(false)
    if (!result.ok) {
      if (result.status === 401) {
        router.replace("/app/login")
        return
      }
      setMarkupMsg({ type: "err", text: result.error })
      return
    }
    const nextDirty = { ...dirtyRef.current, markup: false }
    setDirty(nextDirty)
    await fetchSettingsData(storeCode, { silent: true, sectionDirty: nextDirty })
    setMarkupMsg({ type: "ok", text: "Markup saved." })
  }

  async function handleSavePricing() {
    const value = Number(percentageNetProfitPercent)
    if (!Number.isFinite(value) || value <= 0 || value > 1000) {
      setPricingMsg({ type: "err", text: "Percentage net profit must be between 0 and 1000." })
      return
    }
    const rangesResult = validatePricingRangeRows(tieredProfitRows)
    if (!rangesResult.ok) {
      setPricingMsg({ type: "err", text: rangesResult.error })
      return
    }
    setSavingPricing(true)
    const result = await saveAppSettingsPricing({
      storeCode,
      pricingMode,
      percentageNetProfitPercent: value,
      tieredProfitOverrides: rangesResult.ranges,
    })
    setSavingPricing(false)
    if (!result.ok) {
      setPricingMsg({ type: "err", text: result.error })
      return
    }
    setPricingMsg({ type: "ok", text: "Pricing saved." })
    setDirty(prev => ({ ...prev, pricing: false }))
    await fetchSettingsData(storeCode, { silent: true, sectionDirty: { ...dirtyRef.current, pricing: false } })
  }

  async function handleSaveAddress() {
    const country = toIso2Country(addressForm.country)
    const registrationCountry = toIso2Country(
      addressForm.registrationCountry,
      country
    )
    // If select was showing fallback ISO2 while state was still empty/label, sync before validate.
    if (
      addressForm.country.trim() !== country ||
      addressForm.registrationCountry.trim() !== registrationCountry
    ) {
      setAddressForm(f => ({
        ...f,
        country,
        registrationCountry,
        countryOrRegion: country,
      }))
    }
    if (
      !addressForm.address1.trim() ||
      !addressForm.city.trim() ||
      !addressForm.state.trim() ||
      !addressForm.zip.trim() ||
      !country
    ) {
      setAddressMsg({ type: "err", text: "Address line 1, city, state, ZIP, and country are required." })
      return
    }
    setSavingAddress(true)
    setAddressMsg(null)
    const result = await saveAppSettingsAddress({
      storeCode,
      firstName:           addressForm.firstName.trim(),
      lastName:            addressForm.lastName.trim(),
      company:             addressForm.company.trim() || null,
      address1:            addressForm.address1.trim(),
      address2:            addressForm.address2.trim() || null,
      city:                addressForm.city.trim(),
      state:               addressForm.state.trim(),
      zip:                 addressForm.zip.trim(),
      country,
      registrationCountry,
    })
    setSavingAddress(false)
    if (!result.ok) {
      if (result.status === 401) {
        router.replace("/app/login")
        return
      }
      setAddressMsg({ type: "err", text: result.error })
      return
    }
    const nextDirty = { ...dirtyRef.current, address: false }
    setDirty(nextDirty)
    await fetchSettingsData(storeCode, { silent: true, sectionDirty: nextDirty })
    const syncNote = result.data.ebayLocationSynced
      ? "Address saved and eBay location synced."
      : "Address saved, but eBay location could not be synced."
    setAddressMsg({ type: result.data.ebayLocationSynced ? "ok" : "err", text: syncNote })
  }

  async function handleSavePolicies() {
    setSavingPolicies(true)
    setPoliciesMsg(null)
    const result = await saveAppSettingsPolicies({
      storeCode,
      fulfillmentPolicyId: fulfillmentPolicyId.trim() || null,
      paymentPolicyId:     paymentPolicyId.trim() || null,
      returnPolicyId:      returnPolicyId.trim() || null,
    })
    setSavingPolicies(false)
    if (!result.ok) {
      if (result.status === 401) {
        router.replace("/app/login")
        return
      }
      setPoliciesMsg({ type: "err", text: result.error })
      return
    }
    const nextDirty = { ...dirtyRef.current, policies: false }
    setDirty(nextDirty)
    await fetchSettingsData(storeCode, { silent: true, sectionDirty: nextDirty })
    setPoliciesMsg({ type: "ok", text: "Policies saved." })
  }

  async function handleSaveBanner() {
    setSavingBanner(true)
    setBannerMsg(null)
    const result = await saveAppWarehouseBanner(storeCode, warehouseBanner)
    setSavingBanner(false)
    if (!result.ok) {
      if (result.status === 401) {
        router.replace("/app/login")
        return
      }
      setBannerMsg({ type: "err", text: result.error })
      return
    }
    const nextDirty = { ...dirtyRef.current, banner: false }
    setDirty(nextDirty)
    await fetchSettingsData(storeCode, { silent: true, sectionDirty: nextDirty })
    setBannerMsg({ type: "ok", text: "Warehouse banner setting saved." })
  }

  async function handleReconnectEbay(store: AppStoreSummary) {
    if (reconnectBusyId != null) return
    setStoreMgmtMsg(null)
    setReconnectBusyId(store.storeId)
    const result = await startAppEbayReconnect(store.storeId)
    setReconnectBusyId(null)
    if (!result.ok) {
      if (result.status === 401) {
        router.replace("/app/login")
        return
      }
      setStoreMgmtMsg({ type: "err", text: result.error || "Reconnect could not start." })
      return
    }
    window.location.href = result.data.authUrl
  }

  async function handleRemoveStore(store: AppStoreSummary) {
    if (!removeAck || removeBusyId != null) return
    setRemoveBusyId(store.storeId)
    setStoreMgmtMsg(null)
    const result = await removeAppStore(store.storeId)
    setRemoveBusyId(null)
    if (!result.ok) {
      if (result.status === 401) {
        router.replace("/app/login")
        return
      }
      setStoreMgmtMsg({ type: "err", text: result.error || "Store could not be removed." })
      return
    }
    setRemoveConfirmId(null)
    setRemoveAck(false)
    setStoreMgmtMsg({
      type: "ok",
      text: `${store.name} was removed from ListJetGo. eBay listings were not changed.`,
    })
    const storesResult = await fetchAppStores()
    if (storesResult.ok) {
      const list = storesResult.data.stores
      setStores(list)
      if (list.length === 0) {
        setStoreCode("")
        setSettings(null)
        return
      }
      if (!list.some(s => s.storeCode === storeCode)) {
        const nextId = list[0]!.storeId
        const next = list[0]!.storeCode
        setSelectedStoreId(nextId)
        setStoreCode(next)
        await loadSettings(next)
      }
    }
  }

  async function refreshMailboxes() {
    const result = await fetchAppMailboxStatus()
    if (result.ok) setMailboxAccounts(result.data.accounts)
  }

  async function handleSyncMailbox(accountId: number) {
    if (mailboxBusyId != null) return
    setMailboxBusyId(accountId)
    setMailboxSyncMsg({ type: "ok", text: "Syncing mailbox…" })
    try {
      const result = await syncAppMailbox(accountId)
      if (!result.ok) {
        setMailboxSyncMsg({ type: "err", text: result.error || "Mailbox sync failed." })
        return
      }
      const d = result.data
      if (d.lastError) {
        setMailboxSyncMsg({ type: "err", text: d.lastError })
        return
      }
      setMailboxSyncMsg({
        type: "ok",
        text: [
          `Fetched: ${d.fetched}`,
          `Parsed: ${d.parsed}`,
          `Matched: ${d.matched}`,
          `Needs review: ${d.needsReview}`,
          `Ignored: ${d.ignored}`,
          `Duplicate: ${d.duplicates}`,
        ].join("\n"),
      })
      await refreshMailboxes()
    } catch (e) {
      setMailboxSyncMsg({
        type: "err",
        text: e instanceof Error ? e.message : "Mailbox sync failed.",
      })
    } finally {
      setMailboxBusyId(null)
    }
  }

  async function handleConnectMailbox() {
    if (mailboxBusyId != null) return
    setMailboxBusyId("connect")
    const result = await startAppMailboxConnect()
    if (result.ok) window.location.assign(result.data.authUrl)
    else {
      setMailboxBusyId(null)
      setMailboxSyncMsg({ type: "err", text: result.error })
    }
  }

  async function handleDisconnectMailbox() {
    const account = mailboxDisconnectConfirm
    if (!account || mailboxBusyId != null) return
    const accountId = account.id
    setMailboxBusyId(accountId)
    try {
      const result = await disconnectAppMailbox(accountId)
      if (!result.ok) {
        setMailboxSyncMsg({ type: "err", text: result.error || "Gmail disconnect failed." })
        return
      }
      setMailboxAccounts(prev => prev.map(row =>
        row.id === accountId ? { ...row, status: "DISCONNECTED", lastError: null } : row
      ))
      await refreshMailboxes()
      setMailboxSyncMsg({
        type: "ok",
        text: "Gmail disconnected successfully. Existing order and finance data was preserved.",
      })
    } catch (e) {
      setMailboxSyncMsg({
        type: "err",
        text: e instanceof Error ? e.message : "Gmail disconnect failed.",
      })
    } finally {
      setMailboxDisconnectConfirm(null)
      setMailboxBusyId(null)
    }
  }

  if (loading) {
    return <div style={{ padding: 48, textAlign: "center", color: "var(--dim)" }}>Loading…</div>
  }

  if (!user) return null

  const hasStores = stores.length > 0

  return (
    <div style={{ maxWidth: 840, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <Link href="/app/dashboard" style={{ color: "var(--dim)", fontSize: 14, textDecoration: "none" }}>
          ← Dashboard
        </Link>
      </div>

      <div style={headerRowStyle}>
        <div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
            <h1 style={{ fontFamily: "'Syne', sans-serif", margin: 0, fontSize: 28 }}>Store Settings</h1>
            {refreshing && (
              <span style={{ fontSize: 12, color: "var(--dim)" }}>Refreshing…</span>
            )}
          </div>
          <p style={{ color: "var(--dim)", margin: "8px 0 0", fontSize: 14 }}>
            Configure markup, location, policies, and warehouse banner for your store.
          </p>
        </div>
        {hasStores && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <select
              value={selectedStoreId != null ? String(selectedStoreId) : ""}
              onChange={e => handleStoreChange(e.target.value)}
              style={selectStyle}
            >
              {stores.map(s => (
                <option key={s.storeId} value={s.storeId}>
                  {s.storeCode} — {s.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void refreshSettings()}
              disabled={settingsLoading || refreshing}
              style={toolbarBtnStyle}
            >
              {settingsLoading || refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <Link href="/app/stores" style={{ ...toolbarBtnStyle, textDecoration: "none", color: "inherit" }}>
              Manage Stores
            </Link>
          </div>
        )}
      </div>

      <AppHelpBox text="Settings are store-specific. Markup, policies, address, and warehouse banner apply only to the selected store." />

      <div style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        margin: "0 0 16px",
        padding: 14,
        border: "1px solid rgba(59, 130, 246, 0.35)",
        borderRadius: 10,
        background: "rgba(59, 130, 246, 0.08)",
      }}>
        <span aria-hidden="true" style={{
          width: 22,
          height: 22,
          flex: "0 0 22px",
          border: "1px solid #60a5fa",
          borderRadius: "50%",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#60a5fa",
          fontWeight: 800,
          fontSize: 13,
        }}>i</span>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
          Connect the email addresses associated with your eBay accounts and Amazon purchasing accounts so ListJetGo can match your orders accurately. You can connect multiple email accounts. ListJetGo automatically matches incoming emails to the relevant order and store.
        </p>
      </div>

      <SettingsCard title="Connected Mailboxes">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {mailboxAccounts.length === 0 ? (
            <p style={{ color: "var(--dim)", fontSize: 13, margin: 0 }}>No Gmail accounts connected.</p>
          ) : mailboxAccounts.map(account => (
            <div key={account.id} style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 12,
              background: "var(--surface)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}>
              <div>
                <div style={{ fontWeight: 600 }}>{account.email}</div>
                <div style={{ color: "var(--dim)", fontSize: 12, marginTop: 4 }}>
                  {account.status}
                  {account.lastIngestedAt ? ` · Last sync ${new Date(account.lastIngestedAt).toLocaleString()}` : " · Not synced yet"}
                </div>
                {account.lastError ? <div style={{ color: "#e88", fontSize: 12, marginTop: 4 }}>{account.lastError}</div> : null}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {account.status === "CONNECTED" ? (
                  <button type="button" style={toolbarBtnStyle} disabled={mailboxBusyId != null} onClick={() => void handleSyncMailbox(account.id)}>
                    {mailboxBusyId === account.id ? "Syncing…" : "Sync"}
                  </button>
                ) : (
                  <button type="button" style={toolbarBtnStyle} disabled={mailboxBusyId != null} onClick={() => void handleConnectMailbox()}>
                    Reconnect
                  </button>
                )}
                {account.status !== "DISCONNECTED" && (
                  <button
                    type="button"
                    style={{ ...toolbarBtnStyle, borderColor: "rgba(200,60,60,0.45)", color: "#e88" }}
                    disabled={mailboxBusyId != null}
                    onClick={() => setMailboxDisconnectConfirm(account)}
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </div>
          ))}
          <div>
            <button type="button" style={toolbarBtnStyle} disabled={mailboxBusyId != null} onClick={() => void handleConnectMailbox()}>
              {mailboxBusyId === "connect" ? "Connecting…" : "+ Connect Gmail Account"}
            </button>
          </div>
        </div>
        <SectionMessage msg={mailboxSyncMsg} />
      </SettingsCard>

      <ConfirmModal
        open={mailboxDisconnectConfirm != null}
        title="Disconnect Gmail account?"
        message={
          mailboxDisconnectConfirm
            ? `This will stop ListJetGo from syncing and processing new emails from ${mailboxDisconnectConfirm.email}.`
            : ""
        }
        detail="Existing matched orders, purchase costs, finance data, and previously processed mailbox records will remain in ListJetGo. You can reconnect this Gmail account at any time."
        confirmLabel="Disconnect Gmail"
        cancelLabel="Cancel"
        busy={mailboxDisconnectConfirm != null && mailboxBusyId === mailboxDisconnectConfirm.id}
        busyLabel="Disconnecting…"
        variant="danger"
        onCancel={() => {
          if (mailboxBusyId == null) setMailboxDisconnectConfirm(null)
        }}
        onConfirm={() => void handleDisconnectMailbox()}
      />

      {hasStores && (
        <SettingsCard title="Mağaza yönetimi">
          <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--dim)", lineHeight: 1.5 }}>
            Yeniden bağlama mevcut mağaza kaydını korur. Kaldırma yalnızca ListJetGo’dan pasifleştirir;
            eBay mağazanızı veya listinglerinizi silmez.
          </p>
          {storeMgmtMsg && (
            <p style={{
              margin: "0 0 12px",
              fontSize: 13,
              color: storeMgmtMsg.type === "ok" ? "#6c9" : "#e88",
            }}>
              {storeMgmtMsg.text}
            </p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {stores.map(store => {
              const statusLabel =
                store.connectionHint === "reconnect_suggested"
                  ? "Yeniden bağlantı gerekebilir"
                  : store.connected
                    ? "Bağlı"
                    : "Yeniden bağlantı gerekebilir"
              return (
                <div
                  key={store.storeId}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: 14,
                    background: "var(--surface)",
                  }}
                >
                  <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 10 }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{store.name}</div>
                      <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 4 }}>
                        {store.storeCode} · store_id={store.storeId} · {statusLabel}
                        {store.ebayExpiresAt
                          ? ` · token ${new Date(store.ebayExpiresAt).toLocaleString()}`
                          : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => void handleReconnectEbay(store)}
                        disabled={reconnectBusyId === store.storeId}
                        style={toolbarBtnStyle}
                      >
                        {reconnectBusyId === store.storeId ? "Yönlendiriliyor…" : "eBay’i Yeniden Bağla"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRemoveConfirmId(store.storeId)
                          setRemoveAck(false)
                          setStoreMgmtMsg(null)
                        }}
                        style={{ ...toolbarBtnStyle, borderColor: "rgba(200,60,60,0.45)", color: "#e88" }}
                      >
                        Mağazayı Kaldır
                      </button>
                    </div>
                  </div>

                  {removeConfirmId === store.storeId && (
                    <div
                      style={{
                        marginTop: 12,
                        padding: 12,
                        borderRadius: 8,
                        border: "1px solid rgba(200,60,60,0.35)",
                        background: "rgba(200,60,60,0.06)",
                      }}
                    >
                      <p style={{ margin: "0 0 10px", fontSize: 13, lineHeight: 1.5 }}>
                        Bu işlem eBay mağazanızı veya eBay listinglerinizi silmez.
                        Mağaza yalnızca ListJetGo’dan kaldırılır ve otomatik takip durdurulur.
                        Geçmiş listing, sipariş ve aktivite kayıtları korunur.
                      </p>
                      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, marginBottom: 12 }}>
                        <input
                          type="checkbox"
                          checked={removeAck}
                          onChange={e => setRemoveAck(e.target.checked)}
                        />
                        <span>Anladım — yalnızca ListJetGo’dan kaldır.</span>
                      </label>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          disabled={!removeAck || removeBusyId === store.storeId}
                          onClick={() => void handleRemoveStore(store)}
                          style={{
                            ...toolbarBtnStyle,
                            opacity: !removeAck || removeBusyId === store.storeId ? 0.55 : 1,
                            borderColor: "rgba(200,60,60,0.45)",
                            color: "#e88",
                          }}
                        >
                          {removeBusyId === store.storeId ? "Kaldırılıyor…" : "Onayla ve kaldır"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRemoveConfirmId(null)
                            setRemoveAck(false)
                          }}
                          style={toolbarBtnStyle}
                        >
                          Vazgeç
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </SettingsCard>
      )}

      {isFormDirty && hasStores && (
        <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--dim)" }}>
          You have unsaved changes. Background refresh will not overwrite your edits.
        </p>
      )}

      {error && (
        <div style={errorBoxStyle}>
          <p style={{ margin: "0 0 12px" }}>{error}</p>
          <button
            type="button"
            onClick={() => (hasStores ? void refreshSettings() : void init())}
            style={toolbarBtnStyle}
          >
            Retry
          </button>
        </div>
      )}

      {!hasStores ? (
        <NoStoreEmptyState
          title="Connect a store to configure settings."
          description="After connecting your eBay store, you can set markup, warehouse address, policies, and banner options."
          cta="manage-stores"
        />
      ) : settingsLoading && !settings ? (
        <div style={{ padding: 32, textAlign: "center", color: "var(--dim)" }}>Loading settings…</div>
      ) : settings ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <SettingsCard title="Store Overview">
            <ReadOnlyField label="Store name" value={settings.storeName} />
            <ReadOnlyField label="Store code" value={settings.storeCode} />
          </SettingsCard>

          <SettingsCard title="Pricing / Markup">
            <FormField label="Markup percent">
              <input
                type="number"
                step="0.1"
                min={0}
                max={300}
                value={markupPercent}
                onChange={e => {
                  setMarkupPercent(e.target.value)
                  setDirty(prev => ({ ...prev, markup: true }))
                }}
                style={inputStyle}
              />
            </FormField>
            <SectionMessage msg={markupMsg} />
            <SaveButton onClick={() => void handleSaveMarkup()} saving={savingMarkup} label="Save Markup" />
          </SettingsCard>

          <SettingsCard title="Advanced Pricing">
            <FormField label="Pricing Mode">
              <select value={pricingMode} onChange={e => { setPricingMode(e.target.value as AppStoreSettings["pricingMode"]); setDirty(prev => ({ ...prev, pricing: true })) }} style={inputStyle}>
                <option value="PERCENTAGE_NET_PROFIT">Percentage Net Profit</option>
                <option value="TIERED_MIN_NET_PROFIT">Tiered Minimum Net Profit</option>
              </select>
            </FormField>
            <FormField
              label={
                <span style={{ display: "inline-flex", alignItems: "center" }}>
                  Percentage Net Profit (%)
                  <InfoTooltip text="Profit belirlemediğiniz fiyat aralıklarındaki ürünleriniz, buraya girdiğiniz kâr payı yüzdesi kullanılarak listelenir." />
                </span>
              }
            >
              <input type="number" min={0.01} max={1000} step={0.01} value={percentageNetProfitPercent} onChange={e => { setPercentageNetProfitPercent(e.target.value); setDirty(prev => ({ ...prev, pricing: true })) }} style={inputStyle} />
            </FormField>
            {pricingMode === "TIERED_MIN_NET_PROFIT" && (
              <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr auto",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--dim)",
                    fontWeight: 600,
                  }}
                >
                  <span>Amazon Min ($)</span>
                  <span>Amazon Max ($)</span>
                  <span>Min Net Profit ($)</span>
                  <span style={{ width: 32 }} />
                </div>
                {tieredProfitRows.map((row, index) => (
                  <div
                    key={index}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr 1fr auto",
                      gap: 8,
                      alignItems: "center",
                    }}
                  >
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={row.minPrice}
                      placeholder="0"
                      onChange={e => {
                        const v = e.target.value
                        setTieredProfitRows(prev => prev.map((r, i) => (i === index ? { ...r, minPrice: v } : r)))
                        setDirty(prev => ({ ...prev, pricing: true }))
                      }}
                      style={inputStyle}
                    />
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={row.maxPrice}
                      placeholder="9.99"
                      onChange={e => {
                        const v = e.target.value
                        setTieredProfitRows(prev => prev.map((r, i) => (i === index ? { ...r, maxPrice: v } : r)))
                        setDirty(prev => ({ ...prev, pricing: true }))
                      }}
                      style={inputStyle}
                    />
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={row.minNetProfit}
                      placeholder="2"
                      onChange={e => {
                        const v = e.target.value
                        setTieredProfitRows(prev => prev.map((r, i) => (i === index ? { ...r, minNetProfit: v } : r)))
                        setDirty(prev => ({ ...prev, pricing: true }))
                      }}
                      style={inputStyle}
                    />
                    <button
                      type="button"
                      aria-label="Delete price range"
                      title="Delete"
                      onClick={() => {
                        setTieredProfitRows(prev => prev.filter((_, i) => i !== index))
                        setDirty(prev => ({ ...prev, pricing: true }))
                      }}
                      style={rangeDeleteBtnStyle}
                    >
                      ⌫
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setTieredProfitRows(prev => [...prev, emptyPricingRangeRow()])
                    setDirty(prev => ({ ...prev, pricing: true }))
                  }}
                  style={addRangeBtnStyle}
                >
                  + Add price range
                </button>
              </div>
            )}
            <SectionMessage msg={pricingMsg} />
            <SaveButton onClick={() => void handleSavePricing()} saving={savingPricing} label="Save Pricing" />
          </SettingsCard>

          <SettingsCard title="Location / Address">
            <div style={grid2Style}>
              <FormField label="First name">
                <input value={addressForm.firstName} onChange={e => updateAddressForm(f => ({ ...f, firstName: e.target.value }))} style={inputStyle} />
              </FormField>
              <FormField label="Last name">
                <input value={addressForm.lastName} onChange={e => updateAddressForm(f => ({ ...f, lastName: e.target.value }))} style={inputStyle} />
              </FormField>
              <FormField label="Company">
                <input value={addressForm.company} onChange={e => updateAddressForm(f => ({ ...f, company: e.target.value }))} style={inputStyle} />
              </FormField>
              <FormField label="Address line 1">
                <input value={addressForm.address1} onChange={e => updateAddressForm(f => ({ ...f, address1: e.target.value }))} style={inputStyle} />
              </FormField>
              <FormField label="Address line 2">
                <input value={addressForm.address2} onChange={e => updateAddressForm(f => ({ ...f, address2: e.target.value }))} style={inputStyle} />
              </FormField>
              <FormField label="City">
                <input value={addressForm.city} onChange={e => updateAddressForm(f => ({ ...f, city: e.target.value }))} style={inputStyle} />
              </FormField>
              <FormField label="State">
                <input value={addressForm.state} onChange={e => updateAddressForm(f => ({ ...f, state: e.target.value }))} style={inputStyle} />
              </FormField>
              <FormField label="ZIP">
                <input value={addressForm.zip} onChange={e => updateAddressForm(f => ({ ...f, zip: e.target.value }))} style={inputStyle} />
              </FormField>
              <FormField label="Country">
                <select
                  value={ISO2_SET.has(addressForm.country) ? addressForm.country : toIso2Country(addressForm.country)}
                  onChange={e => updateAddressForm(f => ({
                    ...f,
                    country: e.target.value,
                    countryOrRegion: e.target.value,
                  }))}
                  style={inputStyle}
                >
                  {COUNTRY_OPTIONS.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Registration country">
                <select
                  value={
                    ISO2_SET.has(addressForm.registrationCountry)
                      ? addressForm.registrationCountry
                      : toIso2Country(addressForm.registrationCountry, toIso2Country(addressForm.country))
                  }
                  onChange={e => updateAddressForm(f => ({ ...f, registrationCountry: e.target.value }))}
                  style={inputStyle}
                >
                  {COUNTRY_OPTIONS.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </FormField>
            </div>
            <SectionMessage msg={addressMsg} />
            <SaveButton onClick={() => void handleSaveAddress()} saving={savingAddress} label="Save Address" />
          </SettingsCard>

          <SettingsCard title="eBay Policies">
            <FormField label="Fulfillment Policy">
              <select
                value={fulfillmentPolicyId}
                onChange={e => {
                  setFulfillmentPolicyId(e.target.value)
                  setDirty(prev => ({ ...prev, policies: true }))
                }}
                style={inputStyle}
              >
                <option value="">Select fulfillment policy</option>
                {policyOptions.fulfillmentPolicies.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </FormField>
            <FormField label="Payment Policy">
              <select
                value={paymentPolicyId}
                onChange={e => {
                  setPaymentPolicyId(e.target.value)
                  setDirty(prev => ({ ...prev, policies: true }))
                }}
                style={inputStyle}
              >
                <option value="">Select payment policy</option>
                {policyOptions.paymentPolicies.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </FormField>
            <FormField label="Return Policy">
              <select
                value={returnPolicyId}
                onChange={e => {
                  setReturnPolicyId(e.target.value)
                  setDirty(prev => ({ ...prev, policies: true }))
                }}
                style={inputStyle}
              >
                <option value="">Select return policy</option>
                {policyOptions.returnPolicies.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </FormField>
            <SectionMessage msg={policiesMsg} />
            <SaveButton onClick={() => void handleSavePolicies()} saving={savingPolicies} label="Save Policies" />
          </SettingsCard>

          <SettingsCard title="Warehouse Shipping Banner">
            <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", fontSize: 14 }}>
              <input
                type="checkbox"
                checked={warehouseBanner}
                onChange={e => {
                  setWarehouseBanner(e.target.checked)
                  setDirty(prev => ({ ...prev, banner: true }))
                }}
                style={{ marginTop: 3 }}
              />
              <span>
                Enable warehouse shipping banner for this store
                <span style={{ display: "block", fontSize: 13, color: "var(--dim)", marginTop: 4, lineHeight: 1.45 }}>
                  When enabled, the warehouse shipping banner will be added to product images during publish for this store.
                </span>
              </span>
            </label>
            <div style={{ margin: "16px 0" }}>
              <div style={{ fontSize: 12, color: "var(--dim)", marginBottom: 8 }}>Preview</div>
              <div
                style={{
                  position: "relative",
                  width: 220,
                  height: 220,
                  borderRadius: 8,
                  overflow: "hidden",
                  border: "1px solid var(--border)",
                  opacity: warehouseBanner ? 1 : 0.55,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "#f3f4f6",
                    color: "#9ca3af",
                    fontSize: 12,
                  }}
                >
                  Product image
                </div>
                {warehouseBanner ? (
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      bottom: 0,
                      padding: "8px 10px",
                      background: "#0f172a",
                      color: "#fff",
                      fontSize: 9,
                      fontWeight: 600,
                      textAlign: "center",
                      lineHeight: 1.35,
                    }}
                  >
                    Ships from USA • No Import Fees • 2–3 Day Delivery
                  </div>
                ) : (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "rgba(0,0,0,0.35)",
                    }}
                  >
                    <span
                      style={{
                        background: "var(--surface)",
                        color: "var(--dim)",
                        fontSize: 11,
                        fontWeight: 700,
                        padding: "4px 8px",
                        borderRadius: 4,
                        textTransform: "uppercase",
                      }}
                    >
                      Banner off
                    </span>
                  </div>
                )}
              </div>
            </div>
            <SectionMessage msg={bannerMsg} />
            <SaveButton onClick={() => void handleSaveBanner()} saving={savingBanner} label="Save Banner Setting" />
          </SettingsCard>

          <SettingsCard title="eBay Connection">
            {(() => {
              const connected = ebayStatus?.stores.find(s => s.storeCode === storeCode)?.connected === true
              return (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <span style={{ color: connected ? "#22c55e" : "var(--dim)", fontWeight: 700 }}>
                    {connected ? "CONNECTED" : "DISCONNECTED"}
                  </span>
                  {!connected && <button type="button" style={toolbarBtnStyle} onClick={async () => { const result = await startAppEbayConnect(); if (result.ok) window.location.assign(result.data.authUrl) }}>Connect eBay</button>}
                </div>
              )
            })()}
          </SettingsCard>

        </div>
      ) : null}
      <div style={{marginTop:16}}><SessionSecurityCard /></div>
    </div>
  )
}

function toIso2Country(raw: string, fallback = "US"): string {
  const value = raw.trim().toUpperCase()
  if (ISO2_SET.has(value)) return value
  const inParens = value.match(/\(([A-Z]{2})\)\s*$/)
  if (inParens && ISO2_SET.has(inParens[1]!)) return inParens[1]!
  const aliases: Record<string, string> = {
    TURKEY: "TR",
    "TÜRKİYE": "TR",
    "TÜRKIYE": "TR",
    "UNITED STATES": "US",
    "UNITED STATES OF AMERICA": "US",
    "UNITED KINGDOM": "GB",
  }
  if (aliases[value]) return aliases[value]!
  const byLabel = COUNTRY_OPTIONS.find(
    c => c.label.toUpperCase() === value || value.startsWith(c.label.toUpperCase())
  )
  if (byLabel) return byLabel.value
  return /^[A-Z]{2}$/.test(value) ? value : fallback
}

function SessionSecurityCard() {
  const [methods,setMethods]=useState<{password:{connected:boolean};google:{available:boolean;connected:boolean;email:string|null}}|null>(null)
  const [message,setMessage]=useState("")
  const [pwMsg,setPwMsg]=useState("")
  const [pwErr,setPwErr]=useState("")
  const [pwLoading,setPwLoading]=useState(false)
  const [currentPassword,setCurrentPassword]=useState("")
  const [newPassword,setNewPassword]=useState("")
  const [confirmPassword,setConfirmPassword]=useState("")
  const load=useCallback(async()=>{try{const m=await fetchLoginMethods();setMethods(m)}catch{setMessage("Security settings could not be loaded.")}},[])
  useEffect(()=>{void load()},[load])
  async function changePassword(e: React.FormEvent) {
    e.preventDefault()
    setPwErr("")
    setPwMsg("")
    if (newPassword !== confirmPassword) {
      setPwErr("Passwords do not match")
      return
    }
    setPwLoading(true)
    try {
      await postChangePassword(currentPassword, newPassword, confirmPassword)
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
      setPwMsg("Password updated.")
      await load()
    } catch (err) {
      setPwErr(err instanceof Error ? err.message : "Could not change password")
    } finally {
      setPwLoading(false)
    }
  }
  return <SettingsCard title="Security / Sessions">
    <div style={{marginBottom:16}}><div style={{fontSize:13,fontWeight:600,marginBottom:6}}>Sign-in methods</div><div style={{fontSize:13}}>Password — {methods?.password.connected?"Connected":"Not set"}</div>{methods?.google.available&&<div style={{fontSize:13}}>Google — {methods.google.connected?`Connected${methods.google.email?` as ${methods.google.email}`:""}`:"Not connected"}</div>}</div>
    {methods?.password.connected ? (
      <form onSubmit={e => void changePassword(e)} style={{ marginBottom: 20, padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Şifre Değiştir</div>
        <FormField label="Mevcut şifre">
          <input type="password" required autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} style={inputStyle} />
        </FormField>
        <FormField label="Yeni şifre">
          <input type="password" required minLength={8} autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} style={inputStyle} />
        </FormField>
        <FormField label="Yeni şifre tekrar">
          <input type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} style={inputStyle} />
        </FormField>
        <p style={{ fontSize: 12, color: "var(--dim)", margin: "0 0 10px" }}>En az 8 karakter; en az bir harf ve bir rakam.</p>
        {pwErr && <p style={{ fontSize: 13, color: "#e88", margin: "0 0 8px" }}>{pwErr}</p>}
        {pwMsg && <p style={{ fontSize: 13, color: "#3a8", margin: "0 0 8px" }}>{pwMsg}</p>}
        <button type="submit" disabled={pwLoading} style={toolbarBtnStyle}>{pwLoading ? "Kaydediliyor…" : "Şifreyi güncelle"}</button>
      </form>
    ) : (
      <p style={{ fontSize: 13, color: "var(--dim)", marginBottom: 16 }}>
        ListJetGo şifresi henüz yok. Google ile giriş sonrası “ListJetGo şifrenizi oluşturun” ekranından belirleyebilirsiniz.
      </p>
    )}
    {message&&<p style={{fontSize:13,color:"#e88"}}>{message}</p>}
  </SettingsCard>
}

function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize: 16, margin: "0 0 16px" }}>{title}</h2>
      {children}
    </div>
  )
}

function ReadOnlyField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: "var(--dim)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14 }}>{value?.trim() ? value : "—"}</div>
    </div>
  )
}

function FormField({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: "var(--dim)", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  )
}

function SectionMessage({ msg }: { msg: { type: "ok" | "err"; text: string } | null }) {
  if (!msg) return null
  return (
    <p
      style={{
        margin: "8px 0 12px",
        fontSize: 13,
        color: msg.type === "ok" ? "#6c9" : "#e88",
        whiteSpace: "pre-line",
      }}
    >
      {msg.text}
    </p>
  )
}

function SaveButton({ onClick, saving, label }: { onClick: () => void; saving: boolean; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving}
      style={{
        padding: "8px 16px",
        borderRadius: 6,
        border: "none",
        background: saving ? "var(--dim)" : "var(--accent, #3b82f6)",
        color: "#fff",
        fontWeight: 600,
        cursor: saving ? "wait" : "pointer",
        fontSize: 14,
      }}
    >
      {saving ? "Saving…" : label}
    </button>
  )
}

const headerRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
  marginBottom: 24,
}

const cardStyle: CSSProperties = {
  padding: 20,
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
}

const selectStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "inherit",
}

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg, var(--surface))",
  color: "inherit",
  fontSize: 14,
  boxSizing: "border-box",
}

const grid2Style: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 12,
}

const errorBoxStyle: CSSProperties = {
  padding: 16,
  marginBottom: 16,
  borderRadius: 8,
  border: "1px solid #c44",
  background: "rgba(200,60,60,0.08)",
  color: "#e88",
}

const toolbarBtnStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 14,
}

const addRangeBtnStyle: CSSProperties = {
  ...toolbarBtnStyle,
  justifySelf: "start",
  marginTop: 4,
  marginBottom: 14,
  borderColor: "rgba(0, 255, 136, 0.35)",
  color: "var(--accent, #00ff88)",
  fontWeight: 600,
}

const rangeDeleteBtnStyle: CSSProperties = {
  width: 32,
  height: 36,
  padding: 0,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--dim)",
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
}
