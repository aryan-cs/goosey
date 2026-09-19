import { BookOpen, Scale, ShieldCheck } from "lucide-react";

export default function RulesPage() {
  return <div className="page-shell reading-page">
    <header className="page-header"><h1>How Goosey works 🪿</h1></header>
    <section><h2><BookOpen /> Feathers, not dollars</h2><p>Your feathers are just for fun. You can&apos;t buy them, cash them out, or send them to anyone outside Goosey.</p></section>
    <section><h2>Pick a side</h2><p>Think it&apos;ll happen? Bet YES. Think it won&apos;t? Bet NO. Every market has a deadline and rules for deciding who wins.</p></section>
    <section><h2>Watch the odds move</h2><p>Prices change as people trade. They show what everyone thinks might happen, not what will happen.</p></section>
    <section><h2><Scale /> Get your feathers</h2><p>If you&apos;re right, each winning contract pays 100 feathers. If a market gets cancelled, each contract pays 50.</p></section>
    <section><h2><ShieldCheck /> Don&apos;t be a silly goose</h2><p>No bots, alt accounts, insider info, or being a jerk in the comments. Keep it fun and fair.</p></section>
    <section><h2>Who actually wins?</h2><p>When trading closes, we check what happened and mark the market YES, NO, or VOID. Your feathers are paid out once the result is confirmed.</p></section>
  </div>;
}
