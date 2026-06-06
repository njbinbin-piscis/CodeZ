/**
 * IM gateway ("assistants") IPC — connect Feishu / WeCom / DingTalk / WeChat /
 * Telegram / Slack / Discord / Teams / Matrix / generic webhook channels so
 * inbound messages drive a headless agent turn. Mirrors `commands::gateway`.
 */
import { invoke } from "@tauri-apps/api/core";

export interface ImSettings {
  feishu_app_id: string;
  feishu_app_secret: string;
  feishu_domain: string;
  feishu_enabled: boolean;

  wecom_bot_id: string;
  wecom_bot_secret: string;
  wecom_enabled: boolean;

  dingtalk_app_key: string;
  dingtalk_app_secret: string;
  dingtalk_robot_code: string;
  dingtalk_enabled: boolean;

  telegram_bot_token: string;
  telegram_enabled: boolean;

  slack_webhook_url: string;
  slack_enabled: boolean;
  discord_webhook_url: string;
  discord_enabled: boolean;
  teams_webhook_url: string;
  teams_enabled: boolean;

  matrix_homeserver: string;
  matrix_access_token: string;
  matrix_room_id: string;
  matrix_enabled: boolean;

  webhook_outbound_url: string;
  webhook_auth_token: string;
  webhook_enabled: boolean;

  wechat_enabled: boolean;
  wechat_gateway_port: number;
  wechat_bot_id: string;

  im_message_mode: string;
}

export type ChannelStatus =
  | "Disconnected"
  | "Connecting"
  | "Connected"
  | { Error: string };

export interface ChannelInfo {
  name: string;
  status: ChannelStatus;
  connected_at: number | null;
}

export interface GatewayStatus {
  channels: ChannelInfo[];
}

export interface WechatLoginStatus {
  qr_data_url: string | null;
  qrcode_token: string | null;
  message: string;
  connected: boolean;
  bot_id: string | null;
}

export function getImSettings(): Promise<ImSettings> {
  return invoke<ImSettings>("get_im_settings");
}

export function saveImSettings(updates: ImSettings): Promise<ImSettings> {
  return invoke<ImSettings>("save_im_settings", { updates });
}

export function listGatewayChannels(): Promise<GatewayStatus> {
  return invoke<GatewayStatus>("list_gateway_channels");
}

export function connectGatewayChannels(): Promise<GatewayStatus> {
  return invoke<GatewayStatus>("connect_gateway_channels");
}

export function disconnectGatewayChannels(): Promise<void> {
  return invoke<void>("disconnect_gateway_channels");
}

export function startWechatLogin(): Promise<WechatLoginStatus> {
  return invoke<WechatLoginStatus>("start_wechat_login");
}

export function pollWechatLogin(qrcodeToken: string): Promise<WechatLoginStatus> {
  return invoke<WechatLoginStatus>("poll_wechat_login", { qrcodeToken });
}
