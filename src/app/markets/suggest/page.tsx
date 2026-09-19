import { redirect } from "next/navigation";
import { MARKET_SUGGESTION_FORM_URL } from "@/lib/market-suggestion";

export default function SuggestMarketPage() {
  redirect(MARKET_SUGGESTION_FORM_URL);
}
