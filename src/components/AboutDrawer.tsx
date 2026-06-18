/**
 * AboutDrawer
 *
 * Slide-out drawer explaining the purpose, methodology, and limitations
 * of the Trinidad News Comparer. Emphasises that this tool is NOT a
 * replacement for reading the original articles.
 */

import { motion, AnimatePresence } from "motion/react";
import { Scale, ExternalLink, Lightbulb, AlertTriangle, Shield, X } from "lucide-react";

interface AboutDrawerProps {
  open: boolean;
  onClose: () => void;
}

export default function AboutDrawer({ open, onClose }: AboutDrawerProps) {
  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="about-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/40 z-40"
            onClick={onClose}
          />

          {/* Drawer panel */}
          <motion.div
            key="about-drawer"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 300 }}
            className="fixed top-0 right-0 bottom-0 w-full max-w-lg bg-white z-50 shadow-2xl overflow-y-auto"
          >
            {/* Close button */}
            <button
              onClick={onClose}
              className="absolute top-4 right-4 p-2 rounded-lg hover:bg-slate-100 transition-colors text-slate-400 hover:text-slate-700"
              aria-label="Close about panel"
            >
              <X className="w-5 h-5" />
            </button>

            {/* Content */}
            <div className="p-6 md:p-8 pt-16">
              {/* Header ==== */}
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-red-50 p-2 rounded-lg border border-red-100">
                  <Scale className="w-5 h-5 text-red-600" />
                </div>
                <h2 className="text-lg font-black text-slate-900 tracking-tight">
                  About This Tool
                </h2>
              </div>

              {/* Mission / Filter Bubble Quote ==== */}
              <div className="bg-slate-900 rounded-lg p-5 md:p-6 mb-6 mt-4">
                <p className="text-sm text-slate-300 leading-relaxed italic">
                  "When someone shares misinformation that confirms their world view,
                  they are not just passing along bad information - they are participating
                  in a system that rewards intellectual shortcuts over careful analysis,
                  emotional reaction over thoughtful consideration, and tribal loyalty over
                  independent judgement. The algorithm feeds them more of the curated
                  content. This is what researchers call <strong className="text-white not-italic">filter bubbles</strong>."
                </p>
                <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                  <Lightbulb className="w-3 h-3" />
                  <span>Core mission rationale</span>
                </div>
              </div>

              {/* How It Works ==== */}
              <section className="mb-6">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3">
                  How It Works
                </h3>
                <div className="space-y-3">
                  {[
                    {
                      step: "1",
                      title: "Real-Time Scraping",
                      desc: "We fetch the latest headlines from Trinidad Express, Trinidad Guardian, T&T Newsday, Loop News, and CNC3 via their public RSS feeds and DOM scraping.",
                    },
                    {
                      step: "2",
                      title: "Multi-Agent AI Analysis",
                      desc: "Five specialised NVIDIA NIMs LLM agents expand the topic, match relevant articles, analyse each source's tone and framing, cross-compare findings, and verify the synthesis.",
                    },
                    {
                      step: "3",
                      title: "Side-by-Side Comparison",
                      desc: "We present each source's coverage with its unique angle, emphasised details, and omitted context so you can see how the same story gets framed differently.",
                    },
                  ].map((item) => (
                    <div key={item.step} className="flex gap-3">
                      <div className="w-7 h-7 rounded-full bg-red-100 text-red-700 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                        {item.step}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-800">{item.title}</p>
                        <p className="text-xs text-slate-500 leading-relaxed mt-0.5">{item.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Work in Progress ==== */}
              <section className="mb-6">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3" />
                  Work in Progress
                </h3>
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-2.5">
                  <p className="text-xs text-blue-900 leading-relaxed">
                    This tool is a <strong>work in progress</strong> — a personal exercise in
                    building, experimenting, and learning. The long-term goal is to use it as a
                    practice ground for <strong>identifying and improving critical thinking skills</strong>:
                    recognising media bias, spotting framing choices, noticing what gets emphasised
                    vs. omitted, and becoming a more discerning news consumer.
                  </p>
                  <p className="text-xs text-blue-900 leading-relaxed">
                    Much like calibration exercises in marksmanship or pattern recognition in
                    chess, the act of routinely comparing how different outlets cover the same
                    story trains the mind to <strong>detect slant, question sources, and resist
                    filter bubbles</strong>. This project aims to make that practice more
                    visible and structured.
                  </p>
                  <p className="text-xs text-blue-900 leading-relaxed">
                    The pipeline, UI, accuracy, and methodology will continue to evolve as
                    this exercise develops.
                  </p>
                </div>
              </section>

              {/* What This Is NOT ==== */}
              <section className="mb-6">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3 text-amber-500" />
                  Important Limitations
                </h3>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-2.5">
                  <div className="flex gap-2.5">
                    <span className="text-amber-600 font-bold text-xs flex-shrink-0 mt-0.5">NOT</span>
                    <p className="text-xs text-amber-900 leading-relaxed">
                      <strong>This is NOT a replacement for reading full articles.</strong> The AI summaries
                      and tone analysis are a starting point, not a substitute for the original journalism.
                    </p>
                  </div>
                  <div className="flex gap-2.5">
                    <span className="text-amber-600 font-bold text-xs flex-shrink-0 mt-0.5">NOT</span>
                    <p className="text-xs text-amber-900 leading-relaxed">
                      <strong>We do not determine which source is "right."</strong> Every newsroom has an
                      editorial perspective. Our goal is to surface those differences so you can make up
                      your own mind.
                    </p>
                  </div>
                  <div className="flex gap-2.5">
                    <span className="text-amber-600 font-bold text-xs flex-shrink-0 mt-0.5">NOT</span>
                    <p className="text-xs text-amber-900 leading-relaxed">
                      <strong>We do not display full article text.</strong> Copyright belongs to the
                      respective news organisations. Always click through to the original source.
                    </p>
                  </div>
                </div>
              </section>

              {/* What You Should Do ==== */}
              <section className="mb-6">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-1.5">
                  <ExternalLink className="w-3 h-3" />
                  How to Use This Responsibly
                </h3>
                <ul className="space-y-2 text-xs text-slate-600 leading-relaxed">
                  <li className="flex gap-2">
                    <span className="text-red-500 font-bold">to</span>
                    <span><strong>Click the "Visit Homepage"</strong> or <strong>"Full Coverage"</strong> links on each source card to read the actual article.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-red-500 font-bold">to</span>
                    <span><strong>Compare at least 2–3 sources</strong> on the same topic before forming an opinion. Notice what each emphasises and what it leaves out.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-red-500 font-bold">to</span>
                    <span><strong>Read critically.</strong> Ask yourself: whose perspective is centred? What facts are highlighted? What context might be missing?</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-red-500 font-bold">to</span>
                    <span><strong>Share the tool, not just one headline.</strong> Send someone the comparison view so they see the full landscape, not a single frame.</span>
                  </li>
                </ul>
              </section>

              {/* Transparency ==== */}
              <section className="mb-6">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-1.5">
                  <Shield className="w-3 h-3" />
                  Transparency
                </h3>
                <div className="bg-slate-50 rounded-lg p-4 space-y-2 text-xs text-slate-600 leading-relaxed">
                  <p>
                    <strong>AI Provider:</strong> All analysis runs through NVIDIA NIMs (Llama-3.1-70B,
                    Llama-3.1-8B, Nemotron-4-340B). No user search data is stored or used for model training.
                  </p>
                  <p>
                    <strong>Data Sources:</strong> Headlines are fetched via public RSS feeds and DOM
                    scraping from Trinidad Express, Trinidad Guardian, T&T Newsday, Loop News, and CNC3.
                    We do not bypass paywalls or access subscriber-only content.
                  </p>
                  <p>
                    <strong>Privacy:</strong> This application does not use cookies, tracking scripts, or
                    third-party analytics. Search history is stored only in your browser's localStorage
                    and never sent to our server.
                  </p>
                  <p>
                    <strong>Caching:</strong> Comparison results are cached in Redis for 24 hours to
                    reduce API calls and improve response times. The cache key is derived from your
                    search topic only - no personal data is involved.
                  </p>
                </div>
              </section>

              {/* Footer ==== */}
              <div className="border-t border-slate-100 pt-4 text-center">
                <p className="text-[10px] text-slate-400 font-mono">
                  Built for clearer conversations about Trinidad and Tobago news media.
                </p>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
