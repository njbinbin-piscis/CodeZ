import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  skillEvolutionApi,
  type SkillRevision,
} from "../../services/tauri/skillEvolution";
import "./SessionSkillRevisions.css";

interface SessionSkillRevisionsProps {
  sessionId: string | null;
}

/** WorkZ: list skill revisions tied to the current task session. */
export default function SessionSkillRevisions({ sessionId }: SessionSkillRevisionsProps) {
  const { t } = useTranslation();
  const [revisions, setRevisions] = useState<SkillRevision[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setRevisions([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    skillEvolutionApi
      .listRevisions({ sessionId, limit: 20 })
      .then((res) => {
        if (!cancelled) setRevisions(res.revisions);
      })
      .catch(() => {
        if (!cancelled) setRevisions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!sessionId) return null;

  return (
    <div className="agentz-workz-skill-revisions">
      <div className="agentz-workz-skill-revisions-head">{t("agent.skillRevisionsTitle")}</div>
      {loading && <div className="agentz-workz-skill-revisions-empty">…</div>}
      {!loading && revisions.length === 0 && (
        <div className="agentz-workz-skill-revisions-empty">{t("agent.skillRevisionsEmpty")}</div>
      )}
      {!loading && revisions.length > 0 && (
        <ul className="agentz-workz-skill-revisions-list">
          {revisions.map((rev) => (
            <li key={rev.id} className="agentz-workz-skill-revision-row">
              <span className="agentz-workz-skill-revision-skill">{rev.skill_id}</span>
              <span className="agentz-workz-skill-revision-origin">{rev.origin}</span>
              {rev.diff_summary && (
                <span className="agentz-workz-skill-revision-summary" title={rev.diff_summary}>
                  {rev.diff_summary}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
