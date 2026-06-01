import { parseUserMessageRefs } from "./chatFileRefs";
import "./UserMessage.css";

export default function UserMessage({ text }: { text: string }) {
  const parts = parseUserMessageRefs(text);
  return (
    <div className="codez-msg-text codez-user-message">
      {parts.map((part, i) =>
        part.type === "ref" ? (
          <span key={`${part.path}-${i}`} className="codez-ref-chip" title={part.path}>
            @{part.path}
          </span>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </div>
  );
}
