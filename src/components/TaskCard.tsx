import UserMessage from "./UserMessage";
import "./TaskCard.css";

interface TaskCardProps {
  text: string;
  sticky?: boolean;
}

/** User turn prompt — compact task card instead of a chat bubble. */
export default function TaskCard({ text, sticky = false }: TaskCardProps) {
  if (!text.trim()) return null;
  return (
    <div className={`agentz-task-card${sticky ? " sticky" : ""}`}>
      <UserMessage text={text} />
    </div>
  );
}
