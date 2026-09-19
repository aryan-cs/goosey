import { SearchExperience } from "@/components/search-experience";

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  return <div className="page-shell search-page">
    <header className="page-header"><span className="eyebrow">Find your next call</span><h1>Search Goosey</h1><p>Markets, events, and people are all in one place.</p></header>
    <SearchExperience initialQuery={q} />
  </div>;
}
