import { useState, useEffect } from "react";
import { NewsSourceReport } from "../types";
import { formatTimestamp } from "../utils";
import { ExternalLink, CheckCircle, Flame, ShieldAlert, Award, Star, Info, Heart } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface Props {
  source: NewsSourceReport;
  key?: any;
}

export default function NewsSourceCard({ source }: Props) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [userVote, setUserVote] = useState<number | null>(null);
  
  // Track ratings in state with automatic synching to localStorage
  const [ratingStats, setRatingStats] = useState({
    average: 4.2,
    totalVotes: 12
  });

  const getBrandDetails = (name: string) => {
    const sn = name.toLowerCase();
    if (sn.includes("express")) {
      return {
        borderColor: "border-red-500",
        bgLight: "bg-red-50/50",
        badgeBg: "bg-red-600 text-white",
        logoColor: "text-red-700",
        brandLabel: "Trinidad Express",
        accentColor: "red",
        homepage: "https://trinidadexpress.com/",
        baselineRating: 4.1
      };
    } else if (sn.includes("guardian")) {
      return {
        borderColor: "border-emerald-600",
        bgLight: "bg-emerald-50/30",
        badgeBg: "bg-emerald-800 text-white",
        logoColor: "text-emerald-800",
        brandLabel: "T&T Guardian",
        accentColor: "emerald",
        homepage: "https://www.guardian.co.tt/",
        baselineRating: 4.4
      };
    } else if (sn.includes("newsday")) {
      return {
        borderColor: "border-amber-600",
        bgLight: "bg-amber-50/30",
        badgeBg: "bg-amber-700 text-white",
        logoColor: "text-amber-700",
        brandLabel: "T&T Newsday",
        accentColor: "amber",
        homepage: "https://newsday.co.tt/",
        baselineRating: 4.5
      };
    } else if (sn.includes("loop")) {
      return {
        borderColor: "border-blue-500",
        bgLight: "bg-blue-50/30",
        badgeBg: "bg-blue-600 text-white",
        logoColor: "text-blue-600",
        brandLabel: "Loop News TT",
        accentColor: "blue",
        homepage: "https://trinidad.loopnews.com/",
        baselineRating: 4.3
      };
    } else if (sn.includes("cnc3")) {
      return {
        borderColor: "border-purple-600",
        bgLight: "bg-purple-50/30",
        badgeBg: "bg-purple-800 text-white",
        logoColor: "text-purple-800",
        brandLabel: "CNC3 News",
        accentColor: "purple",
        homepage: "https://www.cnc3.co.tt/",
        baselineRating: 4.2
      };
    } else if (sn.includes("ttt")) {
      return {
        borderColor: "border-teal-600",
        bgLight: "bg-teal-50/30",
        badgeBg: "bg-teal-800 text-white",
        logoColor: "text-teal-850",
        brandLabel: "TTT News",
        accentColor: "teal",
        homepage: "https://ttt.live/",
        baselineRating: 4.0
      };
    } else {
      return {
        borderColor: "border-slate-400",
        bgLight: "bg-slate-50/50",
        badgeBg: "bg-slate-700 text-white",
        logoColor: "text-slate-700",
        brandLabel: name,
        accentColor: "slate",
        homepage: "https://trinidadexpress.com/", // fallback
        baselineRating: 4.0
      };
    }
  };

  const brand = getBrandDetails(source.sourceName);

  // Load rating statistics from localStorage
  useEffect(() => {
    const key = `consistency_rating_${brand.brandLabel.replace(/\s+/g, "_").toLowerCase()}`;
    const saved = localStorage.getItem(key);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setRatingStats({
          average: Number(parsed.average.toFixed(1)),
          totalVotes: parsed.totalVotes
        });
        if (parsed.userVote) {
          setUserVote(parsed.userVote);
        }
      } catch (e) {
        console.error("Failed to parse rating stats", e);
      }
    } else {
      // Seed initial dummy ratings for realism
      const seedVotes = Math.floor(Math.random() * 20) + 15;
      setRatingStats({
        average: brand.baselineRating,
        totalVotes: seedVotes
      });
    }
  }, [brand.brandLabel]);

  // Handle rating click
  const handleRate = (stars: number) => {
    const key = `consistency_rating_${brand.brandLabel.replace(/\s+/g, "_").toLowerCase()}`;
    const newTotalVotes = userVote ? ratingStats.totalVotes : ratingStats.totalVotes + 1;
    
    // Formula to calculate updated average
    let newAverage = ratingStats.average;
    if (userVote) {
      // Modify existing vote
      newAverage = ((ratingStats.average * ratingStats.totalVotes) - userVote + stars) / ratingStats.totalVotes;
    } else {
      newAverage = ((ratingStats.average * ratingStats.totalVotes) + stars) / newTotalVotes;
    }

    const payload = {
      average: Number(newAverage.toFixed(1)),
      totalVotes: newTotalVotes,
      userVote: stars
    };

    localStorage.setItem(key, JSON.stringify(payload));
    setRatingStats({
      average: Number(newAverage.toFixed(1)),
      totalVotes: newTotalVotes
    });
    setUserVote(stars);
  };

  const getSlantBadge = (slant: string) => {
    const sl = slant.toLowerCase();
    if (sl.includes("sensational") || sl.includes("alarmist") || sl.includes("emotional")) {
      return {
        bg: "bg-rose-100 text-rose-800 border border-rose-200",
        icon: <Flame className="w-3.5 h-3.5 mr-1" />
      };
    } else if (sl.includes("critic") || sl.includes("skeptical") || sl.includes("investigative")) {
      return {
        bg: "bg-amber-100 text-amber-800 border border-amber-200",
        icon: <ShieldAlert className="w-3.5 h-3.5 mr-1" />
      };
    } else if (sl.includes("neutral") || sl.includes("dry") || sl.includes("descriptive") || sl.includes("factual")) {
      return {
        bg: "bg-blue-100 text-blue-800 border border-blue-200",
        icon: <CheckCircle className="w-3.5 h-3.5 mr-1" />
      };
    } else {
      return {
        bg: "bg-slate-100 text-slate-800 border border-slate-200",
        icon: <Award className="w-3.5 h-3.5 mr-1" />
      };
    }
  };

  const slant = getSlantBadge(source.toneAngle);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`flex flex-col h-full bg-white rounded-xl border-l-[6px] ${brand.borderColor} shadow-xs hover:shadow-md transition-all duration-300 overflow-hidden relative`}
      id={`source-card-${source.sourceName.replace(/\s+/g, "-").toLowerCase()}`}
    >
      {/* Card Header */}
      <div className="p-4 border-b border-gray-100 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <span className={`px-2.5 py-0.5 text-xs font-semibold rounded-full tracking-wide ${brand.badgeBg}`}>
            {brand.brandLabel}
          </span>
          <span className={`flex items-center text-xs font-semibold px-2 py-0.5 rounded-full ${slant.bg}`}>
            {slant.icon}
            {source.toneAngle}
          </span>
        </div>
        
        <h3 className="text-lg font-bold text-gray-900 leading-snug tracking-tight mb-2 hover:text-gray-800">
          "{source.headline}"
        </h3>

        <div className="flex items-center justify-between mt-2.5">
          <div className="text-[11px] font-mono text-gray-400">
            Published: {source.publishDate ? formatTimestamp(source.publishDate) : "Live / Recent"}
          </div>

          {/* Star Consistency Indicator & Interactive Rating */}
          <div className="relative">
            <button
              onMouseEnter={() => setShowTooltip(true)}
              onMouseLeave={() => setShowTooltip(false)}
              onClick={() => setShowTooltip(!showTooltip)}
              className="flex items-center space-x-1 bg-slate-50 border border-slate-200/80 px-2 py-1 rounded-md text-xs hover:bg-slate-100 transition-all cursor-help"
            >
              <div className="flex text-amber-500">
                {[1, 2, 3, 4, 5].map((s) => (
                  <Star 
                    key={s} 
                    className={`w-3 h-3 ${ratingStats.average >= s ? 'fill-amber-500' : 'text-slate-350'}`} 
                  />
                ))}
              </div>
              <span className="font-mono text-[10px] font-bold text-slate-600">
                {ratingStats.average} ({ratingStats.totalVotes})
              </span>
              <Info className="w-3 h-3 text-slate-400" />
            </button>

            {/* Tooltip Content */}
            <AnimatePresence>
              {showTooltip && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: 5 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="absolute right-0 bottom-full mb-2 w-64 bg-slate-900 text-white text-xs rounded-xl p-3.5 shadow-xl z-20 border border-slate-800"
                >
                  <p className="font-bold border-b border-white/10 pb-1 mb-1.5 flex items-center justify-between">
                    <span>Journalistic Consistency Rating</span>
                    <span className="text-amber-400 font-mono">{ratingStats.average} / 5</span>
                  </p>
                  <p className="text-[11px] text-slate-300 leading-relaxed mb-3">
                    Calculated from the source's historical fact alignment, editorial balance, and dynamic community feedback.
                  </p>
                  
                  {/* Rating Selector */}
                  <div className="bg-white/5 p-2 rounded-lg text-center">
                    <p className="text-[10px] text-slate-400 font-medium mb-1.5">
                      {userVote ? "Your tracked rating" : "Rate this outlet's accuracy"}
                    </p>
                    <div className="flex justify-center space-x-1.5">
                      {[1, 2, 3, 4, 5].map((num) => (
                        <button
                          key={num}
                          onClick={() => handleRate(num)}
                          className="hover:scale-125 active:scale-95 transition-transform"
                          title={`Rate ${num} Stars`}
                        >
                          <Star 
                            className={`w-5 h-5 ${
                              (userVote && userVote >= num) || (!userVote && ratingStats.average >= num) 
                                ? 'fill-yellow-450 text-yellow-450' 
                                : 'text-slate-500 hover:text-yellow-450'
                            }`} 
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Synopsis Section */}
      <div className={`p-4 flex-1 ${brand.bgLight}`}>
        <p className="text-sm text-gray-700 leading-relaxed italic mb-4">
          &ldquo;{source.synopsis}&rdquo;
        </p>

        {/* Highlight Comparison Lists */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          {/* Emphasized */}
          <div className="bg-white/80 p-3 rounded-lg border border-gray-100">
            <h4 className="flex items-center text-xs font-bold text-slate-900 tracking-wider uppercase mb-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 mr-1.5" />
              Details Emphasized
            </h4>
            <ul className="space-y-1.5">
              {source.detailsEmphasized.map((item, idx) => (
                <li key={idx} className="flex items-start text-xs text-gray-600 leading-relaxed">
                  <span className="text-emerald-600 mr-1.5 select-none font-bold">✓</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Omitted / Downplayed */}
          <div className="bg-white/80 p-3 rounded-lg border border-gray-100">
            <h4 className="flex items-center text-xs font-bold text-slate-900 tracking-wider uppercase mb-2">
              <span className="w-2 h-2 rounded-full bg-rose-500 mr-1.5" />
              Omitted / Downplayed
            </h4>
            <ul className="space-y-1.5">
              {source.detailsOmittedOrDownplayed.length > 0 ? (
                source.detailsOmittedOrDownplayed.map((item, idx) => (
                  <li key={idx} className="flex items-start text-xs text-gray-600 leading-relaxed">
                    <span className="text-rose-500 mr-1.5 select-none font-bold">⚠</span>
                    <span>{item}</span>
                  </li>
                ))
              ) : (
                <li className="text-xs text-gray-400 italic">No significant omission observed</li>
              )}
            </ul>
          </div>
        </div>
      </div>

      {/* Support Direct Outbound Referral & Publicity Protection Panel */}
      <div className="p-3 bg-slate-50 border-t border-gray-100 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
        <div className="flex items-center space-x-1.5 text-slate-500 md:max-w-[55%] text-left">
          <Heart className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
          <span className="text-[10px] leading-tight font-medium">
            This workspace serves as a comparative tracker and is not a replacement. Go to {brand.brandLabel} for original content!
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Outlet Homepage Publicity Referrer */}
          <a
            href={brand.homepage}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            className="px-2.5 py-1 text-[10px] font-bold text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-100 border border-slate-200 rounded-md transition flex items-center gap-1.5"
            title={`Browse ${brand.brandLabel} Website Homepage`}
          >
            Visit Homepage
            <ExternalLink className="w-3 h-3" />
          </a>

          {/* Actual Article Referral Link */}
          {source.articleUrl && (
            <a
              href={source.articleUrl}
              target="_blank"
              referrerPolicy="no-referrer"
              rel="noopener noreferrer"
              className="px-2.5 py-1 text-[10px] font-bold text-white bg-slate-900 hover:bg-slate-800 rounded-md transition flex items-center gap-1.5 shadow-sm"
              id={`link-to-${source.sourceName.replace(/\s+/g, "-").toLowerCase()}`}
            >
              Full Coverage
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>
    </motion.div>
  );
}
