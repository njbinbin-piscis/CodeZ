import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ideApi } from "../../services/tauri/ide";
import type { SearchResult } from "./types";

interface SearchPanelProps {
  projectDir: string;
  onResultClick: (path: string, line: number, column: number) => void;
}

interface FileGroup {
  path: string;
  matches: SearchResult[];
}

export default function SearchPanel({ projectDir, onResultClick }: SearchPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  const doSearch = useCallback(async () => {
    if (!query.trim() || !projectDir) {
      setResults([]);
      setHasSearched(false);
      return;
    }
    const reqId = ++reqIdRef.current;
    setSearching(true);
    setError(null);
    setHasSearched(true);
    try {
      const r = await ideApi.searchFiles(projectDir, query.trim(), {
        filePattern: include.trim() || undefined,
        excludePattern: exclude.trim() || undefined,
        caseSensitive,
        wholeWord,
        useRegex,
      });
      if (reqId !== reqIdRef.current) return; // a newer search superseded this one
      setResults(r);
    } catch (e) {
      if (reqId !== reqIdRef.current) return;
      setError(typeof e === "string" ? e : (e as Error)?.message || String(e));
      setResults([]);
    } finally {
      if (reqId === reqIdRef.current) setSearching(false);
    }
  }, [query, projectDir, include, exclude, caseSensitive, wholeWord, useRegex]);

  // Debounced live search as the query / options change.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setHasSearched(false);
      return;
    }
    debounceRef.current = setTimeout(() => void doSearch(), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [doSearch, query]);

  const groups = useMemo<FileGroup[]>(() => {
    const map = new Map<string, SearchResult[]>();
    for (const r of results) {
      const arr = map.get(r.path);
      if (arr) arr.push(r);
      else map.set(r.path, [r]);
    }
    return Array.from(map.entries()).map(([path, matches]) => ({ path, matches }));
  }, [results]);

  const toggleGroup = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const fileName = (p: string) => p.split("/").pop() || p;
  const fileDir = (p: string) => {
    const i = p.lastIndexOf("/");
    return i > 0 ? p.slice(0, i) : "";
  };

  return (
    <div className="search-panel">
      <div className="ide-sidebar-header">
        <span>{t("ide.search") || "Search"}</span>
      </div>

      <div className="search-input-row">
        <input
          type="text"
          className="search-main-input"
          placeholder={t("ide.searchPlaceholder") || "Search"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void doSearch();
          }}
          autoFocus
        />
        <div className="search-toggles">
          <button
            className={caseSensitive ? "active" : ""}
            title="Match Case"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            Aa
          </button>
          <button
            className={wholeWord ? "active" : ""}
            title="Match Whole Word"
            onClick={() => setWholeWord((v) => !v)}
          >
            ab
          </button>
          <button
            className={useRegex ? "active" : ""}
            title="Use Regular Expression"
            onClick={() => setUseRegex((v) => !v)}
          >
            .*
          </button>
        </div>
      </div>

      <input
        type="text"
        className="search-glob-input"
        placeholder={t("ide.searchInclude") || "files to include (e.g. *.ts)"}
        value={include}
        onChange={(e) => setInclude(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void doSearch();
        }}
      />
      <input
        type="text"
        className="search-glob-input"
        placeholder={t("ide.searchExclude") || "files to exclude (e.g. dist,*.min.js)"}
        value={exclude}
        onChange={(e) => setExclude(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void doSearch();
        }}
      />

      {searching && (
        <div className="search-status">{t("common.loading") || "Searching…"}</div>
      )}
      {!searching && error && <div className="search-error">{error}</div>}
      {!searching && !error && hasSearched && results.length === 0 && query.trim() && (
        <div className="search-status">{t("ide.noResults") || "No results found"}</div>
      )}

      {results.length > 0 && (
        <div className="search-summary">
          {results.length} {t("ide.resultsFound") || "results"} · {groups.length}{" "}
          {t("ide.filesFound") || "files"}
        </div>
      )}

      <div className="search-results">
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.path);
          return (
            <div key={g.path} className="search-group">
              <div className="search-group-head" onClick={() => toggleGroup(g.path)} title={g.path}>
                <span className="search-group-caret">{isCollapsed ? "▶" : "▼"}</span>
                <span className="search-group-name">{fileName(g.path)}</span>
                <span className="search-group-dir">{fileDir(g.path)}</span>
                <span className="search-group-count">{g.matches.length}</span>
              </div>
              {!isCollapsed &&
                g.matches.map((r, i) => (
                  <div
                    key={`${r.line}-${r.column}-${i}`}
                    className="search-match"
                    onClick={() => onResultClick(r.path, r.line, r.column)}
                    title={`${r.path}:${r.line}:${r.column}`}
                  >
                    <span className="search-match-line">{r.line}</span>
                    <span className="search-match-text">{r.text.trim()}</span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
