/**
 * Observer 인터페이스 — 단방향(read-only) 관측 plugin (Phase B dashboard contract §3).
 *
 * Channel 은 양방향(handler), Observer 는 단방향(eventBus subscribe). 한 파일에
 * 두면 readability·인격 모델(채널 분류 결정 2026-05-14) 흐려져 별 디렉토리.
 * 본 파일이 `Observer` · `ObserverPluginManifest` · `LoadedObserverPlugin` 의
 * 단일 진실 소스 — loader (`src/core/plugins/observers.ts`) 는 import 만.
 */
import type { EventBus } from "../eventbus.js";

export interface Observer {
  readonly name: string;
  start(eventBus: EventBus): Promise<void>;
  stop(): Promise<void>;
}

export interface ObserverPluginManifest {
  schemaVersion: number;
  kind: "observer";
  name: string;
  /** plugin 디렉토리 기준 상대 경로. default export = Observer class. */
  entry: string;
}

export interface LoadedObserverPlugin {
  manifest: ObserverPluginManifest;
  /** 절대 경로. */
  pluginDir: string;
  /** 인스턴스화 + start() 완료. */
  observer: Observer;
}
