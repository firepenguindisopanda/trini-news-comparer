import { useState, useEffect, useCallback } from "react";
import { NewsComparisonResult, SearchHistoryItem } from "./types";
import { formatTimestamp } from "./utils";
import NewsSourceCard from "./components/NewsSourceCard";
import { useComparisonJob } from "./hooks/useComparisonJob";
import type { JobStatus } from "./hooks/useComparisonJob";
import { 
  Search, 
  Newspaper, 
  FileText, 
  History, 
  AlertCircle, 
  TrendingUp, 
  BookOpen, 
  RefreshCw,
  Scale,
  Award,
  ArrowRight,
  Info
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import AboutDrawer from "./components/AboutDrawer";

// Initial Caribbean preset topics
const PRESET_TOPICS = [
  { label: "WASA Scheduling & Water Infrastructure Updates", query: "WASA water scheduling supply Trinidad" },
  { label: "National Security Measures & Anti-Crime Initiatives", query: "Trinidad police police service national security crime" },
  { label: "CAL Flight Plans & Caribbean Travel News", query: "Caribbean Airlines CAL flight delays travel regional news Trinidad" },
  { label: "Trinidad and Tobago Stock Exchange & Budget Impact", query: "Trinidad budget economy stock exchange currency inflation" },
  { label: "Carnival Preparations & Cultural Grants", query: "Trinidad Carnival band launch artists NCC cultural allocations" },
  { label: "Tobago Autonomy & House of Assembly Discussions", query: "Tobago House of Assembly THA autonomy Chief Secretary" }
];

// API base URL - set via Vite env for subpath deployment (e.g. /news-comparer)
const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

// Pusher config - set via Vite env
const PUSHER_CONFIGURED = Boolean(import.meta.env.VITE_PUSHER_KEY);

export default function App() {
  const [topic, setTopic] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NewsComparisonResult | null>(null);
  const [history, setHistory] = useState<SearchHistoryItem[]>([]);
  
  // About drawer
  const [aboutOpen, setAboutOpen] = useState(false);
  
  // Real-time scraper states
  const [scrapedArticles, setScrapedArticles] = useState<any[]>([]);
  const [loadingScraped, setLoadingScraped] = useState(false);
  const [scrapedFilter, setScrapedFilter] = useState("all");

  // Pusher-powered real-time progress (only if configured)
  const jobState = useComparisonJob(PUSHER_CONFIGURED ? sessionId : null);
  
  // When Pusher is not configured, fall back to polling
  const [pollInterval, setPollInterval] = useState<ReturnType<typeof setInterval> | null>(null);

  // Load history from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("news_compare_history");
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to parse history", e);
      }
    }
  }, []);

  // Fetch real-time scraped headlines of Trinidad on mount
  const fetchScrapedArticles = async () => {
    setLoadingScraped(true);
    try {
      const res = await fetch(`${API_BASE}/api/news/latest`);
      if (res.ok) {
        const data = await res.json();
        setScrapedArticles(data.articles || []);
      }
    } catch (e) {
      console.error("Failed to load scraped news stream", e);
    } finally {
      setLoadingScraped(false);
    }
  };

  useEffect(() => {
    fetchScrapedArticles();
  }, []);

  // Poll fallback: check session status every 3s when Pusher isn't available
  useEffect(() => {
    if (!loading || !sessionId || PUSHER_CONFIGURED) {
      if (pollInterval) {
        clearInterval(pollInterval);
        setPollInterval(null);
      }
      return;
    }

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/news/compare/status/${sessionId}`);
        if (!res.ok) return;
        const data = await res.json();

        if (data.status === "completed") {
          clearInterval(interval);
          // The status endpoint now returns the result directly
          if (data.result) {
            const resultData = data.result as NewsComparisonResult;
            setResult(resultData);
            addToHistory(topic, resultData.summary);
          }
          setLoading(false);
        } else if (data.status === "failed") {
          clearInterval(interval);
          setError("Comparison failed. Please try again.");
          setLoading(false);
        }
      } catch {
        // Keep polling
      }
    }, 3000);

    setPollInterval(interval);
    return () => clearInterval(interval);
  }, [loading, sessionId, topic, PUSHER_CONFIGURED]);

  // Listen for Pusher completion
  useEffect(() => {
    if (jobState.status === "completed" && jobState.result) {
      setResult(jobState.result);
      addToHistory(topic, jobState.result.summary);
      setLoading(false);
    }
    if (jobState.status === "failed") {
      setError(jobState.error || "Comparison failed.");
      setLoading(false);
    }
  }, [jobState.status, jobState.result, jobState.error, topic]);

  const addToHistory = (searchTopic: string, summary: string) => {
    const newHistoryItem: SearchHistoryItem = {
      id: Date.now().toString(),
      topic: searchTopic,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + new Date().toLocaleDateString([], { month: 'short', day: 'numeric' }),
      summarySnapshot: summary
    };
    const updatedHistory = [newHistoryItem, ...history.filter(h => h.topic.toLowerCase() !== searchTopic.toLowerCase())].slice(0, 10);
    setHistory(updatedHistory);
    localStorage.setItem("news_compare_history", JSON.stringify(updatedHistory));
  };

  // Fetch news compared response from backend
  const handleCompare = async (searchQuery: string) => {
    if (!searchQuery.trim()) return;
    
    setLoading(true);
    setError(null);
    setResult(null);
    setSessionId(null);

    // Set topic input to match search
    setTopic(searchQuery);

    try {
      const response = await fetch(`${API_BASE}/api/news/compare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: searchQuery.trim() }),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || errData.details || "Failed to compare news.");
      }

      const data = await response.json();

      // 202 Accepted - async mode with Pusher / polling
      if (response.status === 202) {
        setSessionId(data.sessionId);
        // Don't set loading=false - the Pusher hook or poll loop will
        return;
      }

      // 200 OK - synchronous result (cache HIT or legacy path)
      const resultData = data as NewsComparisonResult;
      setResult(resultData);
      addToHistory(searchQuery, resultData.summary);
      setLoading(false);

    } catch (err: any) {
      console.error(err);
      setError(err.message || "An unexpected error occurred while communicating with our server.");
      setLoading(false);
    }
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem("news_compare_history");
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 pb-20">
      {/* Red, Black, White Header Bar (Republic Colours of Trinidad & Tobago) */}
      <div className="h-2 w-full flex">
        <div className="h-full w-2/5 bg-red-600"></div>
        <div className="h-full w-1/5 bg-black"></div>
        <div className="h-full w-2/5 bg-red-600"></div>
      </div>

      {/* Main Header Container */}
      <header className="bg-white border-b border-slate-200 py-6 shadow-xs sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-2 sm:px-3 lg:px-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center space-x-3">
            <div className="bg-red-50 p-2.5 rounded-xl border border-red-100 flex items-center justify-center">
              <Scale className="w-6 h-6 text-red-600" />
            </div>
            <div>
              <h1 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-2">
                Trinidad News Comparer
                <span className="text-[10px] uppercase font-mono tracking-widest bg-red-100 text-red-800 px-2 py-0.5 rounded-sm font-semibold">
                  Live Grounded API
                </span>
              </h1>
              <p className="text-xs text-slate-500 font-medium">
                Deconstruct slant, framing, and points omitted across major Trinidadian news sources
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-4 text-xs text-slate-400 font-mono">
            <div>
              <span className="font-semibold text-slate-600">Sources:</span> Express, Guardian, Newsday, Loop, CNC3
            </div>
            <button
              onClick={() => setAboutOpen(true)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-red-700 hover:border-red-200 hover:bg-red-50 transition-all duration-150"
            >
              <Info className="w-3 h-3" />
              <span className="font-semibold">About</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-2 sm:px-3 lg:px-4 mt-8">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          
          {/* Left Column - Controls, Preset Choices, Search History */}
          <div className="lg:col-span-1 space-y-6">
            
            {/* The Slant Engine Search Form */}
            <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-xs">
              <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center">
                <Search className="w-3.5 h-3.5 mr-1" />
                Select News Subject
              </h2>
              
              <form onSubmit={(e) => { e.preventDefault(); handleCompare(topic); }} className="space-y-3">
                <div className="relative">
                  <input
                    type="text"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="e.g. WASA water supply, fuel excise tax, Carnival launch..."
                    disabled={loading}
                    className="w-full text-sm bg-slate-50 border border-slate-200 text-slate-800 placeholder-slate-400 rounded-xl px-4 py-3 pb-3 pr-10 focus:ring-2 focus:ring-red-500 focus:bg-white focus:outline-hidden transition-all duration-200"
                    id="search-input"
                  />
                  <div className="absolute right-3 top-3.5 text-slate-400">
                    <Newspaper className="w-4 h-4" />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading || !topic.trim()}
                  className={`w-full py-2.5 px-4 rounded-xl font-bold text-xs uppercase tracking-wide flex items-center justify-center space-x-2 transition-all duration-200 ${
                    loading || !topic.trim()
                      ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                      : "bg-slate-900 text-white hover:bg-slate-800 shadow-xs"
                  }`}
                  id="search-button"
                >
                  {loading ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>{jobState.progress > 0 ? `${jobState.progress}%` : "Queued..."}</span>
                    </>
                  ) : (
                    <>
                      <span>Analyze Discrepancies</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </>
                  )}
                </button>
              </form>
            </div>
            {/* Caribbean presets */}
            <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-xs">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center justify-between">
                <span className="flex items-center">
                  <TrendingUp className="w-3.5 h-3.5 mr-1" />
                  Current Focus Presets
                </span>
              </h3>
              <div className="space-y-2">
                {PRESET_TOPICS.map((p, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      setTopic(p.query);
                      handleCompare(p.query);
                    }}
                    disabled={loading}
                    className="w-full text-left p-2.5 text-xs text-slate-700 hover:text-red-700 hover:bg-red-50/50 rounded-lg border border-slate-100 hover:border-red-100/60 transition-all duration-150 block leading-snug"
                    id={`preset-btn-${idx}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Live Scraped Feed Card */}
            <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-xs flex flex-col h-[380px]">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center">
                  <Newspaper className="w-3.5 h-3.5 mr-1 text-slate-500" />
                  Live Scraped Feed
                </h3>
                <button 
                  onClick={fetchScrapedArticles}
                  disabled={loadingScraped}
                  className="text-slate-400 hover:text-red-700 transition"
                  title="Recrawl Live Trinidad Outlets"
                >
                  <RefreshCw className={`w-3 h-3 ${loadingScraped ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {/* Source filters selector */}
              <div className="flex items-center gap-1 overflow-x-auto pb-2 mb-2 scrollbar-none text-[9px] font-sans flex-wrap">
                {["all", "express", "guardian", "cnc3", "newsday"].map((src) => (
                  <button
                    key={src}
                    onClick={() => setScrapedFilter(src)}
                    className={`px-1.5 py-0.5 rounded font-bold uppercase border transition-all ${
                      scrapedFilter === src 
                        ? "bg-slate-900 border-slate-950 text-white" 
                        : "bg-slate-50 border-slate-100 text-slate-500 hover:bg-slate-150"
                    }`}
                  >
                    {src}
                  </button>
                ))}
              </div>

              {/* Headlines listing */}
              <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                {loadingScraped ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-400 text-[11px] gap-2 py-10">
                    <RefreshCw className="w-5 h-5 animate-spin text-red-650" />
                    <span>Crawling direct news desks...</span>
                  </div>
                ) : scrapedArticles.length > 0 ? (
                  scrapedArticles
                    .filter(art => {
                      if (scrapedFilter === "all") return true;
                      return art.source.toLowerCase().includes(scrapedFilter.toLowerCase());
                    })
                    .map((art, idx) => (
                      <div 
                        key={idx}
                        onClick={() => {
                          setTopic(art.title);
                          handleCompare(art.title);
                        }}
                        className="p-2 rounded-lg border border-slate-100 bg-slate-50/40 hover:bg-red-50/50 hover:border-red-100 cursor-pointer transition text-left group"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className={`text-[8px] font-extrabold uppercase px-1 rounded-sm ${
                            art.source.toLowerCase().includes("express") ? "bg-red-100 text-red-800" :
                            art.source.toLowerCase().includes("guardian") ? "bg-emerald-100 text-emerald-800" :
                            art.source.toLowerCase().includes("newsday") ? "bg-amber-100 text-amber-800" :
                            "bg-slate-100 text-slate-800"
                          }`}>
                            {art.source}
                          </span>
                          <span className="text-[8px] text-slate-450 font-mono">Live</span>
                        </div>
                        <p className="text-[11px] font-semibold text-slate-700 group-hover:text-red-700 leading-tight">
                          {art.title}
                        </p>
                      </div>
                    ))
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-slate-400 text-xs py-10 text-center">
                    No scanned headlines found matching filter.
                  </div>
                )}
              </div>
            </div>

            {/* History stack */}
            {history.length > 0 && (
              <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-xs">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center">
                    <History className="w-3.5 h-3.5 mr-1" />
                    Activity History
                  </h3>
                  <button 
                    onClick={clearHistory}
                    className="text-[10px] text-slate-400 hover:text-red-600 transition-colors"
                  >
                    Clear All
                  </button>
                </div>
                <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
                  {history.map((h) => (
                    <button
                      key={h.id}
                      onClick={() => {
                        setTopic(h.topic);
                        handleCompare(h.topic);
                      }}
                      disabled={loading}
                      className="w-full text-left p-2 rounded-lg hover:bg-slate-50 transition-all font-sans text-xs flex justify-between items-center group border border-dashed border-gray-100"
                      id={`history-btn-${h.id}`}
                    >
                      <div className="truncate pr-1">
                        <p className="font-semibold text-slate-700 group-hover:text-amber-700 truncate">{h.topic}</p>
                        <p className="text-[9px] text-slate-400 font-mono">{h.timestamp}</p>
                      </div>
                      <ArrowRight className="w-3 h-3 text-slate-300 group-hover:text-amber-600 flex-shrink-0" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right Column - Results Area (Loading, Initial Empty State, Error or Real News Comparison grid) */}
          <div className="lg:col-span-3 min-h-[400px]">
            <AnimatePresence mode="wait">
              
              {/* LOADING STATE - Real-time progress from Pusher */}
              {loading && (
                <motion.div
                  key="loading"
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="bg-white rounded-3xl border border-slate-200 p-8 md:p-12 text-center shadow-xs h-full flex flex-col justify-center items-center"
                >
                  <div className="relative mb-6">
                    <div className="w-16 h-16 rounded-full border-4 border-slate-100 border-t-red-600 animate-spin" />
                    <Scale className="w-6 h-6 text-red-600 absolute inset-0 m-auto animate-pulse" />
                  </div>
                  
                  <span className="text-xs uppercase font-mono tracking-widest text-slate-400 font-semibold mb-2">
                    Media Audit Engine Active
                  </span>
                  
                  <h3 className="text-xl font-bold text-slate-800 max-w-lg leading-snug mb-4">
                    Deconstructing newsroom priorities for "{topic}"
                  </h3>

                  <div className="w-full max-w-md bg-slate-100 h-1.5 rounded-full overflow-hidden mb-6">
                    <motion.div 
                      className="bg-red-600 h-full rounded-full"
                      animate={{ width: `${jobState.progress}%` }}
                      transition={{ duration: 0.5 }}
                    />
                  </div>

                  {/* Active Processing Step - live from Pusher */}
                  <div className="bg-slate-50 border border-slate-200/50 rounded-xl px-4 py-2.5 text-xs font-mono text-slate-600 max-w-md w-full text-center shadow-2xs h-10 flex items-center justify-center">
                    {jobState.message || "Starting analysis..."}
                  </div>
                </motion.div>
              )}

              {/* ERROR STATE */}
              {error && !loading && (
                <motion.div
                  key="error"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="bg-rose-50 border border-rose-200 text-rose-950 p-6 rounded-2xl flex items-start space-x-3 shadow-2xs"
                >
                  <AlertCircle className="w-5 h-5 text-rose-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <h3 className="font-bold text-sm">Comparison Lookup Failed</h3>
                    <p className="text-xs text-rose-800 mt-1 leading-relaxed">
                      {error}
                    </p>
                    <p className="text-xs text-rose-500 mt-2 font-mono">
                      Please try rephrasing your topic with simpler keywords (e.g., "Kamla Opposition Trinidad" or "WASA water scheduling Trinidad").
                    </p>
                  </div>
                </motion.div>
              )}

              {/* EMPTY STATE - Prompt user to choose or search */}
              {!loading && !result && !error && (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="bg-white rounded-3xl border border-slate-100 p-8 md:p-16 text-center shadow-xs flex flex-col justify-center items-center"
                >
                  <div className="bg-slate-50 p-4 rounded-2xl mb-4 text-slate-400">
                    <Scale className="w-10 h-10" />
                  </div>
                  <h3 className="text-lg font-bold text-slate-800 tracking-tight mb-2">
                    Trinidad and Tobago Media Coverage Workspace
                  </h3>
                  <p className="text-sm text-slate-500 max-w-md leading-relaxed mb-6">
                    Select one of our live Tobago/Trinidad presets on the left sidebar, or input a custom news event to compare coverage from the Express, Guardian, and Newsday directly.
                  </p>
                  
                  {/* Tip banner */}
                  <div className="bg-slate-50/60 p-4 border border-dashed border-slate-200 rounded-xl max-w-lg leading-relaxed text-[11px] text-slate-500 font-mono text-left space-y-1">
                    <span className="font-bold text-slate-600 uppercase">💡 Journalistic Slant Audit Tip:</span>
                    <p>
                      Pay attention to which facts make the headlines. Investigative publications often emphasize accountability and point-of-failures, while state-focused sources highlight announcements, official briefings, and institutional defenses.
                    </p>
                  </div>
                </motion.div>
              )}

              {/* COMPARED VALUES DISPLAY STATE */}
              {result && !loading && !error && (
                <motion.div
                  key="result"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="space-y-6"
                >
                  
                  {/* The Objective Context Summary (Upper Card) */}
                  <div className="bg-white rounded-3xl p-6 md:p-8 border border-slate-200/80 shadow-xs relative overflow-hidden">
                    <div className="absolute right-0 top-0 bg-red-600 text-white font-mono text-[9px] uppercase tracking-wider px-3 py-1 font-bold rounded-bl-xl shadow-xs">
                      Live Search Analyzed
                    </div>
                    
                    <span className="text-[10px] uppercase font-bold tracking-widest text-slate-400 flex items-center mb-1">
                      <BookOpen className="w-3 h-3 mr-1" />
                      Topic of Comparison
                    </span>

                    <h2 className="text-2xl font-black text-slate-900 tracking-tight mb-2.5">
                      {result.topic}
                    </h2>
                    
                    <p className="text-sm text-slate-700 leading-relaxed max-w-4xl font-normal border-l-2 border-slate-200 pl-3">
                      {result.summary}
                    </p>

                    <div className="mt-4 pt-3.5 border-t border-slate-100 flex flex-wrap items-center justify-between text-[11px] font-mono text-slate-400 gap-2">
                      <span>Live Audit Timestamp: {formatTimestamp(result.lastUpdated)}</span>
                      <span className="flex items-center text-slate-500 bg-slate-50 px-2 py-0.5 rounded-sm">
                        <Scale className="w-3.5 h-3.5 mr-1" /> Grounded Side-by-Side Newsroom Matrix
                      </span>
                    </div>
                  </div>

                  {/* The Big Slate Comparative Synthesis Cards */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Perspective Slant differences */}
                    <div className="bg-slate-900 text-white p-6 rounded-2xl shadow-xs">
                      <h4 className="text-xs uppercase font-bold tracking-widest text-red-400/90 flex items-center mb-2.5">
                        <Scale className="w-3.5 h-3.5 mr-1" />
                        Deconstructed Framing & Slant
                      </h4>
                      <p className="text-xs text-slate-350 leading-relaxed font-sans font-light">
                        {result.synthesis.overallAnalysis}
                      </p>
                    </div>

                    {/* How to read takeaway */}
                    <div className="bg-slate-100 border border-slate-200 p-6 rounded-2xl">
                      <h4 className="text-xs uppercase font-bold tracking-widest text-slate-500 flex items-center mb-2.5">
                        <Award className="w-3.5 h-3.5 mr-1" />
                        Journalism Audit Takeaway
                      </h4>
                      <p className="text-xs text-slate-600 leading-relaxed italic pr-2 font-medium">
                        &ldquo;{result.synthesis.keyTakeaway}&rdquo;
                      </p>
                    </div>
                  </div>

                  {/* Headlines Title */}
                  <div className="pt-4 border-b border-gray-200 pb-2 flex items-center justify-between">
                    <h3 className="text-xs font-extrabold uppercase tracking-widest text-slate-500 flex items-center">
                      <FileText className="w-4 h-4 mr-2" />
                      Individual News Desk Analysis
                    </h3>
                    <span className="text-[10px] font-medium text-slate-400 bg-white px-2 py-1 rounded-sm border border-slate-100">
                      Comparing {result.sourcesFound.length} newsrooms
                    </span>
                  </div>

                  {/* News Outlet Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {result.sourcesFound.map((src, idx) => (
                      <NewsSourceCard key={idx} source={src} />
                    ))}
                  </div>

                </motion.div>
              )}

            </AnimatePresence>
          </div>

        </div>
      </main>

      {/* About drawer */}
      <AboutDrawer open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  );
}
