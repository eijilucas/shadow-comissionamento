export interface Member {
  id: string;
  auth_user_id: string | null;
  name: string;
  email: string | null;
  coupon_code: string;
  is_admin: boolean;
  active: boolean;
  pix_key: string | null;
  pix_key_type: "CPF" | "CNPJ" | "EMAIL" | "PHONE" | "EVP" | null;
  contact_email: string | null;
  created_at: string;
}

export interface SaleItem {
  id: string;
  sale_id: string;
  product_name: string;
  quantity: number;
  created_at: string;
}

export interface Sale {
  id: string;
  member_id: string;
  shopify_order_id: string | null;
  coupon_code: string;
  gross_amount: number;
  net_amount: number | null;
  sale_date: string;
  source: "shopify" | "manual";
  created_at: string;
  sale_items?: SaleItem[];
}

export interface Cycle {
  id: string;
  member_id: string;
  cycle_month: string;
  sales_count: number;
  gross_total: number;
  net_total: number;
  commission_amount: number;
  commission_paid: boolean;
  commission_paid_at: string | null;
  // Gift card acumulado por metas de venda no mês (3/5/7/10/15 vendas).
  // gift_card_sent / _at / _code = controle de envio, não mexido pelo
  // recálculo do ciclo.
  gift_card_value: number;
  gift_card_sent: boolean;
  gift_card_sent_at: string | null;
  gift_card_code: string | null;
  updated_at: string;
}

export interface MemberWithCycle extends Member {
  cycle: Cycle | null;
}

export interface AppConfig {
  id: number;
  commission_base: "gross" | "net";
  commission_rate: number;
  updated_at: string;
}
