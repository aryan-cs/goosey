import { SearchExperience } from "@/components/search-experience";

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  return <div className="page-shell search-page">
    <header className="page-header"><h1>Search Goosey</h1></header>
    <SearchExperience initialQuery={q} />
  </div>;
}
