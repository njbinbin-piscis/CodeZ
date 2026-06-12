import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { installConnector } from "../../../services/tauri/connectors";
import type { MarketItem } from "../../../services/tauri/marketplace";
import MarketGridView from "./MarketGridView";

interface ConnectorsDiscoverViewProps {
  onInstalled?: (connectorId: string) => void;
}

export default function ConnectorsDiscoverView({ onInstalled }: ConnectorsDiscoverViewProps) {
  const { t } = useTranslation();
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doInstall = useCallback(async () => {
    if (!source.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const info = await installConnector(source.trim());
      setSource("");
      onInstalled?.(info.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [source, onInstalled]);

  const handleMarketInstalled = useCallback(
    (item: MarketItem) => {
      onInstalled?.(item.id);
    },
    [onInstalled],
  );

  return (
    <div className="agentz-settings-tabpanel">
      <section className="agentz-settings-section">
        <h3>{t("library.discoverConnectorsTitle")}</h3>
        <p className="agentz-settings-hint">{t("connectors.hint")}</p>
        {error && <div className="agentz-settings-error">{error}</div>}
        <div className="agentz-wb-search">
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doInstall();
            }}
            placeholder={t("connectors.installPlaceholder")}
          />
          <button type="button" onClick={() => void doInstall()} disabled={busy}>
            {busy ? t("connectors.installing") : t("connectors.install")}
          </button>
        </div>
      </section>
      <MarketGridView category="connector" mode="discover" onInstalled={handleMarketInstalled} />
    </div>
  );
}
