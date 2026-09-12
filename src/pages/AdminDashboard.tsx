import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../context/AuthContext";
import { currentCycleMonth, formatCycleMonthLabel, nextCycleMonth } from "../lib/date";
import { extractFunctionErrorMessage, invokeAdminFunction } from "../lib/functions";
import { Header } from "../components/Header";
import { StatCard } from "../components/StatCard";
import { MonthSelector } from "../components/MonthSelector";
import { PencilIcon } from "../components/PencilIcon";
import type { AppConfig, Cycle, Member, MemberWithCycle, Sale } from "../types";

const currencyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateFormatter = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function tierLabel(salesCount: number): string {
  if (salesCount >= 15) return "15+ · R$1.050 gift card + 5%";
  if (salesCount >= 10) return "10+ · R$650 gift card + 5%";
  if (salesCount >= 7) return "7+ · R$400 gift card + 5%";
  if (salesCount >= 6) return "6+ · R$250 gift card + 5%";
  if (salesCount >= 5) return "5+ · R$250 gift card";
  if (salesCount >= 3) return "3+ · R$100 gift card";
  return "sem marco";
}

interface ProductTotal {
  productName: string;
  quantity: number;
}

interface SaleWithMember extends Sale {
  members: { name: string; coupon_code: string } | null;
}

interface PendingPayout extends Cycle {
  members: Pick<Member, "id" | "name" | "coupon_code" | "pix_key" | "pix_key_type" | "is_admin">;
}

interface PendingGiftCard extends Cycle {
  members: Pick<Member, "id" | "name" | "coupon_code" | "contact_email" | "is_admin">;
}

const PIX_KEY_TYPES: { value: NonNullable<Member["pix_key_type"]>; label: string }[] = [
  { value: "CPF", label: "CPF" },
  { value: "CNPJ", label: "CNPJ" },
  { value: "EMAIL", label: "E-mail" },
  { value: "PHONE", label: "Telefone" },
  { value: "EVP", label: "Aleatória" },
];

type SortKey = "name" | "coupon" | "sales" | "gross" | "giftcard" | "commission";
type SortDir = "asc" | "desc";

const SORT_LABEL: Record<SortKey, string> = {
  name: "Membro",
  coupon: "Cupom",
  sales: "Vendas",
  gross: "Valor Líquido",
  giftcard: "Gift Card",
  commission: "Comissão",
};

function sortValue(row: MemberWithCycle, key: SortKey): string | number {
  switch (key) {
    case "name":
      return row.name.toLowerCase();
    case "coupon":
      return row.coupon_code.toLowerCase();
    case "sales":
      return row.cycle?.sales_count ?? 0;
    case "gross":
      return row.cycle?.gross_total ?? 0;
    case "giftcard":
      return row.cycle?.gift_card_value ?? 0;
    case "commission":
      return row.cycle?.commission_amount ?? 0;
  }
}

function productsLabel(sale: Sale): string {
  const items = sale.sale_items ?? [];
  if (items.length === 0) return "—";
  return items.map((item) => (item.quantity > 1 ? `${item.product_name} (x${item.quantity})` : item.product_name)).join(", ");
}

export function AdminDashboard() {
  const { member, signOut } = useAuth();
  const [rows, setRows] = useState<MemberWithCycle[]>([]);
  const [inactiveRows, setInactiveRows] = useState<Member[]>([]);
  const [productTotals, setProductTotals] = useState<ProductTotal[]>([]);
  const [recentSales, setRecentSales] = useState<SaleWithMember[]>([]);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<{ coupon: string; password: string } | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [availableMonths, setAvailableMonths] = useState<string[]>([currentCycleMonth()]);
  const [selectedMonth, setSelectedMonth] = useState(currentCycleMonth());
  const nextMonth = nextCycleMonth(selectedMonth);

  const [reloadTick, setReloadTick] = useState(0);

  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCoupon, setEditCoupon] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  function handleStartEdit(row: Member) {
    setEditingMemberId(row.id);
    setEditName(row.name);
    setEditCoupon(row.coupon_code);
    setEditError(null);
  }

  function handleCancelEdit() {
    setEditingMemberId(null);
    setEditError(null);
  }

  async function handleSaveEdit(id: string) {
    const name = editName.trim();
    const coupon = editCoupon.trim().toUpperCase();

    if (!name || !coupon) {
      setEditError("Preenche nome e cupom.");
      return;
    }

    const couponChanged = rows.find((r) => r.id === id)?.coupon_code !== coupon;

    setSavingEdit(true);
    const { error } = await supabase.from("members").update({ name, coupon_code: coupon }).eq("id", id);

    if (error) {
      setSavingEdit(false);
      setEditError(error.code === "23505" ? `Já existe um membro com o cupom "${coupon}".` : "Não deu pra salvar. Tenta de novo.");
      return;
    }

    // Cupom mudou de nome -- renomeia (não recria) na Shopify, se esse
    // membro já tiver um cupom sincronizado lá.
    if (couponChanged) {
      const { data: shopifyData, error: shopifyError } = await invokeAdminFunction("shopify-sync-coupon", {
        member_id: id,
        action: "rename",
        new_coupon_code: coupon,
      });
      if (shopifyError || shopifyData?.error) {
        setEditError((await extractFunctionErrorMessage(shopifyError, shopifyData)) ?? "Cupom salvo, mas não deu pra renomear na Shopify.");
      }
    }

    setSavingEdit(false);
    setEditingMemberId(null);
    setReloadTick((t) => t + 1);
  }

  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [commissionPctDraft, setCommissionPctDraft] = useState("");
  const [savingConfig, setSavingConfig] = useState(false);
  const [configMessage, setConfigMessage] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  function loadAppConfig() {
    supabase
      .from("app_config")
      .select("*")
      .eq("id", 1)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        setAppConfig(data);
        setCommissionPctDraft(String(Math.round(data.commission_rate * 10000) / 100));
      });
  }

  async function handleSaveConfig() {
    setConfigError(null);
    setConfigMessage(null);

    const commissionPct = Number(commissionPctDraft);

    if (!Number.isFinite(commissionPct) || commissionPct < 0 || commissionPct > 100) {
      setConfigError("Comissão precisa ser um número entre 0 e 100.");
      return;
    }

    setSavingConfig(true);

    const { error: updateError } = await supabase
      .from("app_config")
      .update({ commission_rate: commissionPct / 100, updated_at: new Date().toISOString() })
      .eq("id", 1);

    if (updateError) {
      setSavingConfig(false);
      setConfigError("Não deu pra salvar. Tenta de novo.");
      return;
    }

    // Recalcula os ciclos do mês selecionado com a regra nova, senão só
    // valeria a partir da próxima venda de cada membro.
    await supabase.rpc("recalc_all_cycles_for_month", { p_cycle_month: selectedMonth });

    setSavingConfig(false);
    setConfigMessage("Configuração salva e ciclos recalculados.");
    loadAppConfig();
  }

  async function handleResetPassword(memberId: string) {
    setResetError(null);
    setResetResult(null);
    setResettingId(memberId);

    const { data, error } = await invokeAdminFunction("reset-member-password", { member_id: memberId });

    setResettingId(null);

    if (error || data?.error) {
      setResetError((await extractFunctionErrorMessage(error, data)) ?? "Não deu pra resetar a senha. Tenta de novo.");
      return;
    }

    setResetResult({ coupon: data.coupon_code, password: data.temp_password });
  }

  const [creatingLoginId, setCreatingLoginId] = useState<string | null>(null);

  async function handleCreateLogin(memberId: string) {
    setResetError(null);
    setResetResult(null);
    setCreatingLoginId(memberId);

    const { data, error } = await invokeAdminFunction("create-member-login", { member_id: memberId });

    setCreatingLoginId(null);

    if (error || data?.error) {
      setResetError((await extractFunctionErrorMessage(error, data)) ?? "Não deu pra criar o login. Tenta de novo.");
      return;
    }

    setResetResult({ coupon: data.coupon_code, password: data.temp_password });
    setReloadTick((t) => t + 1);
  }

  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleDeleteMember(row: Member) {
    const typed = window.prompt(
      `Isso apaga "${row.name}" (${row.coupon_code}) DE VEZ, junto com todo o histórico de vendas/comissão dele. Não tem como desfazer.\n\nPra confirmar, digite o cupom exatamente: ${row.coupon_code}`,
    );
    if (typed !== row.coupon_code) {
      if (typed !== null) window.alert("Cupom não bateu — nada foi apagado.");
      return;
    }

    setDeletingId(row.id);
    const { data, error } = await invokeAdminFunction("delete-member", { member_id: row.id });
    setDeletingId(null);

    if (error || data?.error) {
      const reason = await extractFunctionErrorMessage(error, data);
      window.alert(`Não deu pra apagar${reason ? `: ${reason}` : ". Tenta de novo."}`);
      return;
    }

    if (data?.shopify_delete_warning) {
      window.alert(data.shopify_delete_warning);
    }

    setReloadTick((t) => t + 1);
  }

  const [manualSaleMemberId, setManualSaleMemberId] = useState("");
  const [manualSaleAmount, setManualSaleAmount] = useState("");
  const [manualSaleProduct, setManualSaleProduct] = useState("");
  const [addingManualSale, setAddingManualSale] = useState(false);
  const [manualSaleError, setManualSaleError] = useState<string | null>(null);
  const [manualSaleSuccess, setManualSaleSuccess] = useState<string | null>(null);

  async function handleAddManualSale() {
    setManualSaleError(null);
    setManualSaleSuccess(null);

    const amount = Number(manualSaleAmount.replace(",", "."));
    if (!manualSaleMemberId) {
      setManualSaleError("Escolhe o membro.");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setManualSaleError("Valor precisa ser maior que zero.");
      return;
    }

    setAddingManualSale(true);
    const { data, error } = await invokeAdminFunction("add-manual-sale", {
      member_id: manualSaleMemberId,
      gross_amount: amount,
      product_name: manualSaleProduct.trim() || undefined,
    });
    setAddingManualSale(false);

    if (error || data?.error) {
      setManualSaleError((await extractFunctionErrorMessage(error, data)) ?? "Não deu pra registrar a venda. Tenta de novo.");
      return;
    }

    const memberName = rows.find((r) => r.id === manualSaleMemberId)?.name ?? "membro";
    setManualSaleSuccess(`Venda de ${currencyFormatter.format(amount)} registrada pra ${memberName}.`);
    setManualSaleMemberId("");
    setManualSaleAmount("");
    setManualSaleProduct("");
    setReloadTick((t) => t + 1);
  }

  const [deletingSaleId, setDeletingSaleId] = useState<string | null>(null);
  const [deleteSaleError, setDeleteSaleError] = useState<string | null>(null);

  async function handleDeleteSale(sale: SaleWithMember) {
    const confirmed = window.confirm(
      `Remover a venda de ${currencyFormatter.format(sale.gross_amount)} de ${sale.members?.name ?? "—"} (${dateFormatter.format(new Date(sale.sale_date))})? Isso recalcula o ciclo do mês dele na hora.`,
    );
    if (!confirmed) return;

    setDeleteSaleError(null);
    setDeletingSaleId(sale.id);
    const { data, error } = await invokeAdminFunction("delete-sale", { sale_id: sale.id });
    setDeletingSaleId(null);

    if (error || data?.error) {
      setDeleteSaleError((await extractFunctionErrorMessage(error, data)) ?? "Não deu pra remover a venda. Tenta de novo.");
      return;
    }

    setReloadTick((t) => t + 1);
  }

  const [reactivatingId, setReactivatingId] = useState<string | null>(null);

  async function handleReactivateMember(id: string) {
    setReactivatingId(id);
    await supabase.from("members").update({ active: true }).eq("id", id);
    setReactivatingId(null);
    setReloadTick((t) => t + 1);
  }

  // --- Pagamento de comissão via PIX (dia 5) -------------------------------
  // O crédito de R$5K fica na conta do Asaas. O botão "Enviar PIX" chama a
  // function pay-commission-pix, que usa a API de Transferências do Asaas
  // pra transferir de verdade — só marca commission_paid depois que o Asaas
  // confirma. Sem a API Key configurada (ver
  // supabase/functions/pay-commission-pix), a function recusa com erro
  // claro em vez de fingir que enviou.
  const [pendingPayouts, setPendingPayouts] = useState<PendingPayout[]>([]);
  const [payingCycleId, setPayingCycleId] = useState<string | null>(null);
  const [payingAll, setPayingAll] = useState(false);
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [pixKeyDrafts, setPixKeyDrafts] = useState<Record<string, string>>({});
  const [pixKeyTypeDrafts, setPixKeyTypeDrafts] = useState<Record<string, string>>({});
  const [savingPixKeyId, setSavingPixKeyId] = useState<string | null>(null);
  const [transfersUsedThisMonth, setTransfersUsedThisMonth] = useState(0);

  // --- Gift card (recompensa por meta de venda, mês fechado) -------------
  // Valor vem calculado no ciclo (cycles.gift_card_value, acumulativo pelas
  // metas). Admin não digita valor -- só confirma. Um único gift card por
  // membro/mês; send-gift-card marca gift_card_sent.
  const [pendingGiftCards, setPendingGiftCards] = useState<PendingGiftCard[]>([]);
  const [contactEmailDrafts, setContactEmailDrafts] = useState<Record<string, string>>({});
  const [savingContactEmailId, setSavingContactEmailId] = useState<string | null>(null);
  const [sendingGiftCardId, setSendingGiftCardId] = useState<string | null>(null);
  const [giftCardError, setGiftCardError] = useState<string | null>(null);
  const [giftCardSuccess, setGiftCardSuccess] = useState<string | null>(null);

  function handleContactEmailChange(memberId: string, value: string) {
    setContactEmailDrafts((prev) => ({ ...prev, [memberId]: value }));
  }

  async function handleContactEmailBlur(memberId: string, originalValue: string) {
    const value = (contactEmailDrafts[memberId] ?? "").trim();
    if (value === (originalValue ?? "")) return;

    setSavingContactEmailId(memberId);
    await supabase.from("members").update({ contact_email: value || null }).eq("id", memberId);
    setSavingContactEmailId(null);
  }

  async function handleSendGiftCard(giftCard: PendingGiftCard) {
    setGiftCardError(null);
    setGiftCardSuccess(null);

    const email = (contactEmailDrafts[giftCard.members.id] ?? giftCard.members.contact_email ?? "").trim();
    if (!email) {
      setGiftCardError(`Cadastra o e-mail de contato de ${giftCard.members.name} antes de enviar.`);
      return;
    }

    const typed = window.prompt(
      `Vai criar um gift card de ${currencyFormatter.format(giftCard.gift_card_value)} pra ${giftCard.members.name}, mandado pra ${email}.\n\nPra confirmar, digite ENVIAR:`,
    );
    if (typed !== "ENVIAR") {
      if (typed !== null) window.alert('Não digitou "ENVIAR" — nada foi enviado.');
      return;
    }

    setSendingGiftCardId(giftCard.id);
    const { data, error } = await invokeAdminFunction("send-gift-card", {
      member_id: giftCard.members.id,
      cycle_id: giftCard.id,
    });
    setSendingGiftCardId(null);

    if (error || data?.error) {
      setGiftCardError((await extractFunctionErrorMessage(error, data)) ?? "Não deu pra enviar o gift card. Tenta de novo.");
      return;
    }

    setGiftCardSuccess(`Gift card enviado pra ${giftCard.members.name} (${email}).`);
    loadPayments();
  }

  function loadPayments() {
    supabase
      .from("cycles")
      .select("*, members!inner(id, name, coupon_code, pix_key, pix_key_type, is_admin)")
      .lt("cycle_month", currentCycleMonth())
      .gt("commission_amount", 0)
      .eq("commission_paid", false)
      .order("cycle_month", { ascending: true })
      .then(({ data }) => {
        const payouts = ((data as unknown as PendingPayout[]) ?? []).filter((p) => !p.members.is_admin);
        setPendingPayouts(payouts);
        setPixKeyDrafts((prev) => {
          const next = { ...prev };
          for (const p of payouts) {
            if (!(p.members.id in next)) next[p.members.id] = p.members.pix_key ?? "";
          }
          return next;
        });
        setPixKeyTypeDrafts((prev) => {
          const next = { ...prev };
          for (const p of payouts) {
            if (!(p.members.id in next)) next[p.members.id] = p.members.pix_key_type ?? "";
          }
          return next;
        });
      });

    // Gift card de mês fechado, ainda não enviado.
    supabase
      .from("cycles")
      .select("*, members!inner(id, name, coupon_code, contact_email, is_admin)")
      .lt("cycle_month", currentCycleMonth())
      .gt("gift_card_value", 0)
      .eq("gift_card_sent", false)
      .order("cycle_month", { ascending: true })
      .then(({ data }) => {
        const cards = ((data as unknown as PendingGiftCard[]) ?? []).filter((g) => !g.members.is_admin);
        setPendingGiftCards(cards);
        setContactEmailDrafts((prev) => {
          const next = { ...prev };
          for (const g of cards) {
            if (!(g.members.id in next)) next[g.members.id] = g.members.contact_email ?? "";
          }
          return next;
        });
      });

    // Asaas dá 30 transferências PIX grátis por mês (calendário, não ciclo
    // de vendas) — a partir da 31ª cobra R$2 cada. Conta quantas comissões
    // já foram pagas (= quantos PIX já saíram) neste mês corrente, pra
    // avisar o admin do custo operacional antes de disparar o resto. Isso é
    // só informativo — nunca desconta da comissão do afiliado.
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    supabase
      .from("cycles")
      .select("id", { count: "exact", head: true })
      .eq("commission_paid", true)
      .gte("commission_paid_at", monthStart.toISOString())
      .then(({ count }) => setTransfersUsedThisMonth(count ?? 0));
  }

  useEffect(() => {
    loadPayments();

    const channel = supabase
      .channel("payments-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "cycles" }, () => loadPayments())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  function handlePixKeyChange(memberId: string, value: string) {
    setPixKeyDrafts((prev) => ({ ...prev, [memberId]: value }));
  }

  async function handlePixKeyBlur(memberId: string, originalValue: string) {
    const value = (pixKeyDrafts[memberId] ?? "").trim();
    if (value === (originalValue ?? "")) return;

    setSavingPixKeyId(memberId);
    await supabase.from("members").update({ pix_key: value || null }).eq("id", memberId);
    setSavingPixKeyId(null);
  }

  async function handlePixKeyTypeChange(memberId: string, value: string) {
    setPixKeyTypeDrafts((prev) => ({ ...prev, [memberId]: value }));
    setSavingPixKeyId(memberId);
    await supabase.from("members").update({ pix_key_type: value || null }).eq("id", memberId);
    setSavingPixKeyId(null);
  }

  async function callPayCommissionPix(cycleIds: string[]): Promise<boolean> {
    const { data, error } = await invokeAdminFunction("pay-commission-pix", { cycle_ids: cycleIds });

    if (error || data?.error) {
      setPayoutError((await extractFunctionErrorMessage(error, data)) ?? "Não deu pra enviar o PIX. Tenta de novo.");
      return false;
    }

    const results = (data?.results ?? []) as { memberName: string; ok: boolean; reason?: string }[];
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      setPayoutError(`Falhou pra ${failed.map((r) => `${r.memberName}${r.reason ? ` (${r.reason})` : ""}`).join(", ")}.`);
    }

    loadPayments();
    return failed.length === 0;
  }

  async function handleSendPix(payout: PendingPayout) {
    setPayoutError(null);

    const pixKey = (pixKeyDrafts[payout.members.id] ?? payout.members.pix_key ?? "").trim();
    const pixKeyType = (pixKeyTypeDrafts[payout.members.id] ?? payout.members.pix_key_type ?? "").trim();
    if (!pixKey || !pixKeyType) {
      setPayoutError(`Cadastra a chave PIX (e o tipo) de ${payout.members.name} antes de enviar.`);
      return;
    }

    const typed = window.prompt(
      `Vai enviar ${currencyFormatter.format(payout.commission_amount)} via PIX pra ${payout.members.name} (${payout.members.coupon_code}).\n\nPra confirmar, digite ENVIAR:`,
    );
    if (typed !== "ENVIAR") {
      if (typed !== null) window.alert('Não digitou "ENVIAR" — nada foi enviado.');
      return;
    }

    setPayingCycleId(payout.id);
    await callPayCommissionPix([payout.id]);
    setPayingCycleId(null);
  }

  async function handleSendPixAll() {
    setPayoutError(null);

    const missingPixKey = visiblePendingPayouts.find(
      (p) =>
        !(pixKeyDrafts[p.members.id] ?? p.members.pix_key ?? "").trim() ||
        !(pixKeyTypeDrafts[p.members.id] ?? p.members.pix_key_type ?? "").trim(),
    );
    if (missingPixKey) {
      setPayoutError(`Cadastra a chave PIX (e o tipo) de ${missingPixKey.members.name} antes de enviar pra todos.`);
      return;
    }

    const names = visiblePendingPayouts.map((p) => `${p.members.name} — ${currencyFormatter.format(p.commission_amount)}`).join("\n");
    const typed = window.prompt(
      `Vai enviar PIX pra ${visiblePendingPayouts.length} pessoa(s), total ${currencyFormatter.format(totalPendingPayout)}:\n\n${names}\n\nPra confirmar, digite ENVIAR:`,
    );
    if (typed !== "ENVIAR") {
      if (typed !== null) window.alert('Não digitou "ENVIAR" — nada foi enviado.');
      return;
    }

    setPayingAll(true);
    await callPayCommissionPix(visiblePendingPayouts.map((p) => p.id));
    setPayingAll(false);
  }

  useEffect(() => {
    loadAppConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    supabase
      .from("cycles")
      .select("cycle_month")
      .order("cycle_month", { ascending: false })
      .then(({ data }) => {
        const months = Array.from(new Set((data ?? []).map((r) => r.cycle_month as string)));
        setAvailableMonths(months.includes(currentCycleMonth()) ? months : [currentCycleMonth(), ...months]);
      });
  }, []);

  useEffect(() => {
    async function load() {
      const [{ data: members }, { data: inactiveMembers }, { data: cycles }, { data: items }, { data: sales }] = await Promise.all([
        supabase.from("members").select("*").eq("active", true).order("name"),
        supabase.from("members").select("*").eq("active", false).eq("is_admin", false).order("name"),
        supabase.from("cycles").select("*").eq("cycle_month", selectedMonth),
        supabase
          .from("sale_items")
          .select("product_name, quantity, sales!inner(sale_date)")
          .gte("sales.sale_date", selectedMonth)
          .lt("sales.sale_date", nextMonth),
        supabase
          .from("sales")
          .select("*, sale_items(id, product_name, quantity), members(name, coupon_code)")
          .gte("sale_date", selectedMonth)
          .lt("sale_date", nextMonth)
          .order("sale_date", { ascending: false }),
      ]);

      const cyclesByMember = new Map<string, Cycle>((cycles ?? []).map((c) => [c.member_id, c]));
      const merged: MemberWithCycle[] = (members ?? [])
        .filter((m: Member) => !m.is_admin)
        .map((m: Member) => ({ ...m, cycle: cyclesByMember.get(m.id) ?? null }));
      setRows(merged);
      setInactiveRows(inactiveMembers ?? []);

      const totalsByProduct = new Map<string, number>();
      for (const item of items ?? []) {
        totalsByProduct.set(item.product_name, (totalsByProduct.get(item.product_name) ?? 0) + item.quantity);
      }
      const totals = Array.from(totalsByProduct.entries())
        .map(([productName, quantity]) => ({ productName, quantity }))
        .sort((a, b) => b.quantity - a.quantity);
      setProductTotals(totals);

      setRecentSales((sales as unknown as SaleWithMember[]) ?? []);
    }

    load();

    const channel = supabase
      .channel("admin-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "cycles" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "sales" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "sale_items" }, () => load())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMonth, reloadTick]);

  const [sortKey, setSortKey] = useState<SortKey>("sales");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "name" || key === "coupon" ? "asc" : "desc");
  }

  const [memberSearch, setMemberSearch] = useState("");

  const sortedRows = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    const filtered = query
      ? rows.filter((r) => r.name.toLowerCase().includes(query) || r.coupon_code.toLowerCase().includes(query))
      : rows;

    const copy = [...filtered];
    copy.sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : va - (vb as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir, memberSearch]);

  // `pendingPayouts` traz TODOS os meses fechados com comissão pendente,
  // não só o que tá selecionado no seletor de mês do topo (a query em
  // loadPayments não filtra por mês). Sem esse filtro, o mesmo pagamento
  // aparecia igual não importa qual mês você tivesse navegando -- parecia
  // "duplicado" entre o mês atual e o anterior. Mostra só o que é do mês
  // que tá sendo visto.
  const visiblePendingPayouts = pendingPayouts.filter((p) => p.cycle_month === selectedMonth);

  const totalPendingPayout = visiblePendingPayouts.reduce((sum, p) => sum + p.commission_amount, 0);

  const ASAAS_FREE_TRANSFERS_PER_MONTH = 30;
  const ASAAS_FEE_PER_TRANSFER = 2;
  const transfersIfSendAllNow = transfersUsedThisMonth + visiblePendingPayouts.length;
  const extraTransferFees = Math.max(0, transfersIfSendAllNow - ASAAS_FREE_TRANSFERS_PER_MONTH) * ASAAS_FEE_PER_TRANSFER;

  const totalSales = rows.reduce((sum, r) => sum + (r.cycle?.sales_count ?? 0), 0);
  const totalGross = rows.reduce((sum, r) => sum + (r.cycle?.gross_total ?? 0), 0);
  const totalGiftCard = rows.reduce((sum, r) => sum + (r.cycle?.gift_card_value ?? 0), 0);
  const totalCommission = rows.reduce((sum, r) => sum + (r.cycle?.commission_amount ?? 0), 0);

  // Ranking ao vivo do ciclo em andamento (mês atual, ainda não fechou pra
  // pagamento) — separado da lista de pendentes abaixo, que só mostra mês
  // já encerrado. Só faz sentido mostrar quando o seletor de mês tá no mês
  // corrente (senão "ciclo atual" seria enganoso).
  const currentMonthEarners =
    selectedMonth === currentCycleMonth()
      ? rows
          .filter((r) => (r.cycle?.commission_amount ?? 0) > 0)
          .sort((a, b) => (b.cycle?.commission_amount ?? 0) - (a.cycle?.commission_amount ?? 0))
      : [];

  // Mesmo espírito de currentMonthEarners, mas pro gift card acumulado --
  // ranking do ciclo em andamento (informativo, só envia no fechamento).
  const currentGiftCardEarners =
    selectedMonth === currentCycleMonth()
      ? rows
          .filter((r) => (r.cycle?.gift_card_value ?? 0) > 0)
          .sort((a, b) => (b.cycle?.gift_card_value ?? 0) - (a.cycle?.gift_card_value ?? 0))
      : [];

  // Gift cards de mês fechado, filtrados pro mês selecionado no topo.
  const visiblePendingGiftCards = pendingGiftCards.filter((g) => g.cycle_month === selectedMonth);
  const totalPendingGiftCards = visiblePendingGiftCards.reduce((sum, g) => sum + g.gift_card_value, 0);

  return (
    <div className="mm-app-frame">
      <Header
        memberName={member?.name}
        onSignOut={signOut}
        rightSlot={
          <Link to="/dashboard" className="mm-link-btn">
            Meu Painel
          </Link>
        }
      />

      <section className="mm-table-section" style={{ marginBottom: 24 }}>
        <h2 className="mm-section-title">Configurações</h2>
        <div className="mm-label" style={{ marginBottom: 16 }}>
          Comissão fixa, ativa a partir de 6 vendas no mês (sobre o valor vendido no mês inteiro).
        </div>

        {configMessage && (
          <div className="mm-reset-banner">
            {configMessage}
            <button type="button" className="mm-link-btn" onClick={() => setConfigMessage(null)}>
              Fechar
            </button>
          </div>
        )}
        {configError && (
          <div className="mm-reset-banner mm-reset-banner-error">
            {configError}
            <button type="button" className="mm-link-btn" onClick={() => setConfigError(null)}>
              Fechar
            </button>
          </div>
        )}

        <div className="mm-config-grid">
          <div className="mm-field">
            <label className="mm-label" htmlFor="commission-pct">
              Comissão (%)
            </label>
            <input
              id="commission-pct"
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={commissionPctDraft}
              onChange={(e) => setCommissionPctDraft(e.target.value)}
            />
          </div>

          <button type="button" className="mm-config-save-btn" disabled={savingConfig || !appConfig} onClick={handleSaveConfig}>
            {savingConfig ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </section>

      <div className="mm-section-header">
        <div className="mm-label">{selectedMonth === currentCycleMonth() ? "Ciclo atual" : "Ciclo encerrado"}</div>
        <MonthSelector months={availableMonths} selected={selectedMonth} onChange={setSelectedMonth} />
      </div>

      <div className="mm-admin-summary-grid">
        <StatCard label="Vendas do Mês" value={String(totalSales)} />
        <StatCard label="Valor Líquido" value={currencyFormatter.format(totalGross)} />
        <StatCard label="Gift Cards do Mês" value={currencyFormatter.format(totalGiftCard)} accent />
        <StatCard label="Comissões do Mês" value={currencyFormatter.format(totalCommission)} accent />
      </div>

      <section className="mm-table-section" style={{ marginBottom: 24 }}>
        <h2 className="mm-section-title">Pagamento de Comissão (PIX)</h2>

        {payoutError && (
          <div className="mm-reset-banner mm-reset-banner-error">
            {payoutError}
            <button type="button" className="mm-link-btn" onClick={() => setPayoutError(null)}>
              Fechar
            </button>
          </div>
        )}

        <div className="mm-admin-summary-grid" style={{ marginBottom: 8 }}>
          <StatCard label="Comissão Total a Enviar" value={currencyFormatter.format(totalPendingPayout)} accent />
        </div>

        <div className="mm-label" style={{ marginBottom: 20 }}>
          {transfersUsedThisMonth} de {ASAAS_FREE_TRANSFERS_PER_MONTH} transferências PIX grátis já usadas este mês
          {extraTransferFees > 0
            ? ` — enviar as ${visiblePendingPayouts.length} pendentes agora passaria do limite e custaria ~${currencyFormatter.format(extraTransferFees)} em taxa do Asaas (R$2 por transferência extra).`
            : "."}
        </div>

        {selectedMonth === currentCycleMonth() && (
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-label)" }}>
              Comissão do Ciclo Atual (em andamento)
            </h3>
            {currentMonthEarners.length === 0 ? (
              <div className="mm-empty-state">Ninguém bateu comissão neste ciclo ainda.</div>
            ) : (
              <table className="mm-table">
                <thead>
                  <tr>
                    <th>Membro</th>
                    <th>Vendas</th>
                    <th>Comissão</th>
                  </tr>
                </thead>
                <tbody>
                  {currentMonthEarners.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <span className="mm-member-row-name">{row.name}</span>{" "}
                        <span className="mm-member-row-coupon">{row.coupon_code}</span>
                      </td>
                      <td>{row.cycle?.sales_count ?? 0}</td>
                      <td className="mm-cell-amount">{currencyFormatter.format(row.cycle?.commission_amount ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        <h3 style={{ margin: "0 0 12px", fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-label)" }}>
          Pronto pra Pagar (meses fechados)
        </h3>

        {visiblePendingPayouts.length === 0 ? (
          <div className="mm-empty-state">Nenhuma comissão pendente de pagamento pra {formatCycleMonthLabel(selectedMonth)}.</div>
        ) : (
          <>
            <table className="mm-table">
              <thead>
                <tr>
                  <th>Membro</th>
                  <th>Mês</th>
                  <th>Comissão</th>
                  <th>Chave PIX</th>
                  <th>Tipo</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visiblePendingPayouts.map((payout) => (
                  <tr key={payout.id}>
                    <td>
                      <span className="mm-member-row-name">{payout.members.name}</span>{" "}
                      <span className="mm-member-row-coupon">{payout.members.coupon_code}</span>
                    </td>
                    <td>{formatCycleMonthLabel(payout.cycle_month)}</td>
                    <td className="mm-cell-amount">{currencyFormatter.format(payout.commission_amount)}</td>
                    <td>
                      <input
                        className="mm-inline-edit-input"
                        type="text"
                        placeholder="Chave PIX"
                        value={pixKeyDrafts[payout.members.id] ?? ""}
                        onChange={(e) => handlePixKeyChange(payout.members.id, e.target.value)}
                        onBlur={() => handlePixKeyBlur(payout.members.id, payout.members.pix_key ?? "")}
                        disabled={savingPixKeyId === payout.members.id}
                      />
                    </td>
                    <td>
                      <select
                        className="mm-inline-edit-input"
                        value={pixKeyTypeDrafts[payout.members.id] ?? ""}
                        onChange={(e) => handlePixKeyTypeChange(payout.members.id, e.target.value)}
                        disabled={savingPixKeyId === payout.members.id}
                      >
                        <option value="">Tipo</option>
                        {PIX_KEY_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="mm-link-btn"
                        disabled={payingCycleId === payout.id || payingAll}
                        onClick={() => handleSendPix(payout)}
                      >
                        {payingCycleId === payout.id ? "Enviando..." : "Enviar PIX"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <button
              type="button"
              className="mm-config-save-btn"
              style={{ marginTop: 16, marginBottom: 16 }}
              disabled={payingAll}
              onClick={handleSendPixAll}
            >
              {payingAll ? "Enviando..." : `Enviar PIX para todos (${currencyFormatter.format(totalPendingPayout)})`}
            </button>
          </>
        )}
      </section>

      <section className="mm-table-section" style={{ marginBottom: 24 }}>
        <h2 className="mm-section-title">Pagamento de Gift Card</h2>
        <div className="mm-label" style={{ marginBottom: 16 }}>
          Recompensa por meta de venda no mês (3→R$100, 5→+R$150, 7→+R$150, 10→+R$250, 15→+R$400). Um único gift card
          por membro no fechamento do mês — cria na Shopify e manda o código por e-mail.
        </div>

        {giftCardSuccess && (
          <div className="mm-reset-banner">
            {giftCardSuccess}
            <button type="button" className="mm-link-btn" onClick={() => setGiftCardSuccess(null)}>
              Fechar
            </button>
          </div>
        )}
        {giftCardError && (
          <div className="mm-reset-banner mm-reset-banner-error">
            {giftCardError}
            <button type="button" className="mm-link-btn" onClick={() => setGiftCardError(null)}>
              Fechar
            </button>
          </div>
        )}

        {selectedMonth === currentCycleMonth() && (
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-label)" }}>
              Gift Card do Ciclo Atual (em andamento)
            </h3>
            {currentGiftCardEarners.length === 0 ? (
              <div className="mm-empty-state">Ninguém bateu meta de gift card neste ciclo ainda.</div>
            ) : (
              <table className="mm-table">
                <thead>
                  <tr>
                    <th>Membro</th>
                    <th>Vendas</th>
                    <th>Gift Card Acumulado</th>
                  </tr>
                </thead>
                <tbody>
                  {currentGiftCardEarners.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <span className="mm-member-row-name">{row.name}</span>{" "}
                        <span className="mm-member-row-coupon">{row.coupon_code}</span>
                      </td>
                      <td>{row.cycle?.sales_count ?? 0}</td>
                      <td className="mm-cell-amount">{currencyFormatter.format(row.cycle?.gift_card_value ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        <h3 style={{ margin: "0 0 12px", fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-label)" }}>
          Pronto pra Enviar (meses fechados)
          {visiblePendingGiftCards.length > 0 && (
            <span style={{ color: "var(--text-primary)", marginLeft: 8 }}>
              — total {currencyFormatter.format(totalPendingGiftCards)}
            </span>
          )}
        </h3>

        {visiblePendingGiftCards.length === 0 ? (
          <div className="mm-empty-state">Nenhum gift card pendente de envio pra {formatCycleMonthLabel(selectedMonth)}.</div>
        ) : (
          <div className="mm-table-hscroll">
          <table className="mm-table">
            <thead>
              <tr>
                <th>Membro</th>
                <th>Mês</th>
                <th>Valor</th>
                <th>E-mail de contato</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visiblePendingGiftCards.map((giftCard) => (
                <tr key={giftCard.id}>
                  <td>
                    <span className="mm-member-row-name">{giftCard.members.name}</span>{" "}
                    <span className="mm-member-row-coupon">{giftCard.members.coupon_code}</span>
                  </td>
                  <td>{formatCycleMonthLabel(giftCard.cycle_month)}</td>
                  <td className="mm-cell-amount">{currencyFormatter.format(giftCard.gift_card_value)}</td>
                  <td>
                    <input
                      className="mm-inline-edit-input"
                      type="text"
                      placeholder="email@exemplo.com"
                      value={contactEmailDrafts[giftCard.members.id] ?? ""}
                      onChange={(e) => handleContactEmailChange(giftCard.members.id, e.target.value)}
                      onBlur={() => handleContactEmailBlur(giftCard.members.id, giftCard.members.contact_email ?? "")}
                      disabled={savingContactEmailId === giftCard.members.id}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="mm-link-btn"
                      disabled={sendingGiftCardId === giftCard.id}
                      onClick={() => handleSendGiftCard(giftCard)}
                    >
                      {sendingGiftCardId === giftCard.id ? "Enviando..." : "Enviar Gift Card"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section className="mm-table-section" style={{ marginBottom: 24 }}>
        <h2 className="mm-section-title">Adicionar Venda Manual (WhatsApp)</h2>
        <div className="mm-label" style={{ marginBottom: 16 }}>
          Pra pedido fechado fora da Shopify. Entra no ciclo do mês igual a uma venda normal.
        </div>

        {manualSaleSuccess && (
          <div className="mm-reset-banner">
            {manualSaleSuccess}
            <button type="button" className="mm-link-btn" onClick={() => setManualSaleSuccess(null)}>
              Fechar
            </button>
          </div>
        )}
        {manualSaleError && (
          <div className="mm-reset-banner mm-reset-banner-error">
            {manualSaleError}
            <button type="button" className="mm-link-btn" onClick={() => setManualSaleError(null)}>
              Fechar
            </button>
          </div>
        )}

        <div className="mm-config-grid">
          <div className="mm-field">
            <label className="mm-label" htmlFor="manual-sale-member">
              Membro
            </label>
            <select
              id="manual-sale-member"
              value={manualSaleMemberId}
              onChange={(e) => setManualSaleMemberId(e.target.value)}
            >
              <option value="">Selecione...</option>
              {rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} ({row.coupon_code})
                </option>
              ))}
            </select>
          </div>

          <div className="mm-field">
            <label className="mm-label" htmlFor="manual-sale-amount">
              Valor (R$)
            </label>
            <input
              id="manual-sale-amount"
              type="text"
              inputMode="decimal"
              placeholder="0,00"
              value={manualSaleAmount}
              onChange={(e) => setManualSaleAmount(e.target.value)}
            />
          </div>

          <div className="mm-field">
            <label className="mm-label" htmlFor="manual-sale-product">
              Produto (opcional)
            </label>
            <input
              id="manual-sale-product"
              type="text"
              value={manualSaleProduct}
              onChange={(e) => setManualSaleProduct(e.target.value)}
            />
          </div>

          <button type="button" className="mm-config-save-btn" disabled={addingManualSale} onClick={handleAddManualSale}>
            {addingManualSale ? "Registrando..." : "Registrar Venda"}
          </button>
        </div>
      </section>

      <section className="mm-table-section">
        <div className="mm-section-header" style={{ marginBottom: 16 }}>
          <h2 className="mm-section-title" style={{ marginBottom: 0 }}>
            Membros
          </h2>
          <input
            type="text"
            className="mm-search-input"
            placeholder="Buscar por nome ou cupom..."
            value={memberSearch}
            onChange={(e) => setMemberSearch(e.target.value)}
          />
        </div>

        {resetResult && (
          <div className="mm-reset-banner">
            Senha de <strong>{resetResult.coupon}</strong> resetada. Nova senha temporária:{" "}
            <strong>{resetResult.password}</strong> (vai pedir pra trocar no próximo login).
            <button type="button" className="mm-link-btn" onClick={() => setResetResult(null)}>
              Fechar
            </button>
          </div>
        )}
        {resetError && (
          <div className="mm-reset-banner mm-reset-banner-error">
            {resetError}
            <button type="button" className="mm-link-btn" onClick={() => setResetError(null)}>
              Fechar
            </button>
          </div>
        )}
        {editError && (
          <div className="mm-reset-banner mm-reset-banner-error">
            {editError}
            <button type="button" className="mm-link-btn" onClick={() => setEditError(null)}>
              Fechar
            </button>
          </div>
        )}

        {rows.length === 0 ? (
          <div className="mm-empty-state">Nenhum membro cadastrado.</div>
        ) : sortedRows.length === 0 ? (
          <div className="mm-empty-state">Nenhum membro encontrado pra "{memberSearch}".</div>
        ) : (
          <div className="mm-table-scroll">
          <table className="mm-table">
            <thead>
              <tr>
                {(["name", "coupon", "sales", "gross", "giftcard", "commission"] as SortKey[]).map((key) => (
                  <th key={key}>
                    <button type="button" className="mm-sort-th-btn" onClick={() => handleSort(key)}>
                      {SORT_LABEL[key]}
                      {sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                    </button>
                  </th>
                ))}
                <th>Marco</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const salesCount = row.cycle?.sales_count ?? 0;
                return (
                  <tr key={row.id}>
                    {editingMemberId === row.id ? (
                      <>
                        <td>
                          <input
                            className="mm-inline-edit-input"
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="mm-inline-edit-input"
                            type="text"
                            value={editCoupon}
                            onChange={(e) => setEditCoupon(e.target.value)}
                          />
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="mm-member-row-name">
                          {row.name}
                          <button
                            type="button"
                            className="mm-edit-icon-btn"
                            aria-label={`Editar ${row.name}`}
                            onClick={() => handleStartEdit(row)}
                          >
                            <PencilIcon />
                          </button>
                        </td>
                        <td className="mm-member-row-coupon">{row.coupon_code}</td>
                      </>
                    )}
                    <td>{salesCount}</td>
                    <td className="mm-cell-amount">{currencyFormatter.format(row.cycle?.gross_total ?? 0)}</td>
                    <td className="mm-cell-amount">{currencyFormatter.format(row.cycle?.gift_card_value ?? 0)}</td>
                    <td className="mm-cell-amount">{currencyFormatter.format(row.cycle?.commission_amount ?? 0)}</td>
                    <td>
                      <span className={`mm-tier-badge${salesCount >= 3 ? " mm-tier-active" : ""}`}>
                        {tierLabel(salesCount)}
                      </span>
                    </td>
                    <td>
                      {editingMemberId === row.id ? (
                        <div className="mm-header-buttons" style={{ borderLeft: "none", paddingLeft: 0 }}>
                          <button type="button" className="mm-link-btn" disabled={savingEdit} onClick={() => handleSaveEdit(row.id)}>
                            {savingEdit ? "Salvando..." : "Salvar"}
                          </button>
                          <button type="button" className="mm-link-btn" disabled={savingEdit} onClick={handleCancelEdit}>
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <div className="mm-header-buttons" style={{ borderLeft: "none", paddingLeft: 0 }}>
                          {row.auth_user_id ? (
                            <button
                              type="button"
                              className="mm-link-btn"
                              disabled={resettingId === row.id}
                              onClick={() => handleResetPassword(row.id)}
                            >
                              {resettingId === row.id ? "Resetando..." : "Resetar senha"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="mm-link-btn"
                              disabled={creatingLoginId === row.id}
                              onClick={() => handleCreateLogin(row.id)}
                            >
                              {creatingLoginId === row.id ? "Criando..." : "Criar login"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="mm-link-btn mm-remove-btn"
                            disabled={deletingId === row.id}
                            onClick={() => handleDeleteMember(row)}
                          >
                            {deletingId === row.id ? "Excluindo..." : "Excluir"}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}

        {inactiveRows.length > 0 && (
          <>
            <h2 className="mm-section-title" style={{ marginTop: 32 }}>
              Membros Removidos
            </h2>
            <table className="mm-table">
              <thead>
                <tr>
                  <th>Membro</th>
                  <th>Cupom</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {inactiveRows.map((row) => (
                  <tr key={row.id}>
                    <td className="mm-member-row-name">{row.name}</td>
                    <td className="mm-member-row-coupon">{row.coupon_code}</td>
                    <td>
                      <div className="mm-header-buttons" style={{ borderLeft: "none", paddingLeft: 0 }}>
                        <button
                          type="button"
                          className="mm-link-btn"
                          disabled={reactivatingId === row.id}
                          onClick={() => handleReactivateMember(row.id)}
                        >
                          {reactivatingId === row.id ? "Reativando..." : "Reativar"}
                        </button>
                        <button
                          type="button"
                          className="mm-link-btn mm-remove-btn"
                          disabled={deletingId === row.id}
                          onClick={() => handleDeleteMember(row)}
                        >
                          {deletingId === row.id ? "Excluindo..." : "Excluir"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="mm-table-section" style={{ marginTop: 24 }}>
        <h2 className="mm-section-title">Peças Vendidas no Mês</h2>
        {productTotals.length === 0 ? (
          <div className="mm-empty-state">Nenhuma peça vendida neste mês.</div>
        ) : (
          <table className="mm-table">
            <thead>
              <tr>
                <th>Produto</th>
                <th>Quantidade</th>
              </tr>
            </thead>
            <tbody>
              {productTotals.map((p) => (
                <tr key={p.productName}>
                  <td>{p.productName}</td>
                  <td className="mm-cell-amount">{p.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mm-table-section" style={{ marginTop: 24 }}>
        <h2 className="mm-section-title">Vendas do Mês (Todos os Membros)</h2>

        {deleteSaleError && (
          <div className="mm-reset-banner mm-reset-banner-error">
            {deleteSaleError}
            <button type="button" className="mm-link-btn" onClick={() => setDeleteSaleError(null)}>
              Fechar
            </button>
          </div>
        )}

        {recentSales.length === 0 ? (
          <div className="mm-empty-state">Nenhuma venda registrada neste mês.</div>
        ) : (
          <table className="mm-table">
            <thead>
              <tr>
                <th>Membro</th>
                <th>Produtos</th>
                <th>Data</th>
                <th>Valor</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {recentSales.map((sale) => (
                <tr key={sale.id}>
                  <td>
                    <span className="mm-member-row-name">{sale.members?.name ?? "—"}</span>{" "}
                    <span className="mm-member-row-coupon">{sale.members?.coupon_code}</span>
                  </td>
                  <td>
                    {productsLabel(sale)}
                    {sale.source === "manual" && (
                      <span className="mm-tier-badge" style={{ marginLeft: 8 }}>
                        WhatsApp
                      </span>
                    )}
                  </td>
                  <td>{dateFormatter.format(new Date(sale.sale_date))}</td>
                  <td className="mm-cell-amount">{currencyFormatter.format(sale.gross_amount)}</td>
                  <td>
                    <button
                      type="button"
                      className="mm-link-btn mm-remove-btn"
                      disabled={deletingSaleId === sale.id}
                      onClick={() => handleDeleteSale(sale)}
                    >
                      {deletingSaleId === sale.id ? "Removendo..." : "Remover"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
