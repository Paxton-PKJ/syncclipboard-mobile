/**
 * QuickActionApp
 * Lightweight RN root component for the transparent QuickActionActivity.
 * Renders only a semi-transparent overlay with the sync progress card.
 * Registered as "quickAction" in the AppRegistry (separate from "main").
 *
 * Supports three modes:
 * 1. Quick tile mode (direction): download/upload from quick settings tile
 * 2. Process text mode (text): upload selected text from Android text selection menu
 * 3. Share mode (shareMode): receive shared content from other apps (Android only)
 */

import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, StatusBar, Platform, BackHandler } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  addIncomingShareSessionListener,
  getActiveShareSession,
  type IncomingSessionMeta,
} from 'native-util';
import { ThemeProvider } from './contexts/ThemeContext';
import { I18nProvider } from './contexts/I18nContext';
import { QuickTileLoadingScreen } from './screens/QuickTileLoadingScreen';
import { ProcessTextScreen } from './screens/ProcessTextScreen';
import { DirectShareReceiveScreen } from './screens/DirectShareReceiveScreen';
import { SyncDirection } from './types/sync';
import { useSettingsStore } from './stores';
import { initLogger } from './utils/Logger';
import { requestServiceRuntime } from './services/ServiceRuntime';
import { networkAutoSwitchService } from './services/NetworkAutoSwitchService';

interface QuickActionAppProps {
  direction?: string;
  text?: string;
  shareMode?: boolean;
  shareSession?: IncomingSessionMeta;
  systemTheme?: 'light' | 'dark';
}

export default function QuickActionApp({
  direction,
  text,
  shareMode,
  shareSession,
  systemTheme,
}: QuickActionAppProps) {
  const syncDirection = direction === 'upload' ? SyncDirection.Upload : SyncDirection.Download;
  const { loadConfig, isLoaded } = useSettingsStore();
  const [isServerSelectionComplete, setIsServerSelectionComplete] = useState(
    Platform.OS !== 'android'
  );
  const [activeShareSession, setActiveShareSession] = useState<IncomingSessionMeta | undefined>(
    shareSession
  );

  useEffect(() => {
    initLogger();
  }, []);

  useEffect(() => {
    setActiveShareSession(shareSession);
  }, [shareSession]);

  useEffect(() => {
    if (!shareMode || Platform.OS !== 'android') return;

    const latest = getActiveShareSession();
    if (latest && latest.sessionId) {
      setActiveShareSession((prev) => (prev?.sessionId === latest.sessionId ? prev : latest));
    }

    const sub = addIncomingShareSessionListener((nextSession) => {
      setActiveShareSession(nextSession);
    });

    return () => {
      sub?.remove();
    };
  }, [shareMode]);

  useEffect(() => {
    if (!isLoaded) {
      loadConfig();
    }
  }, [isLoaded, loadConfig]);

  // 公共入口先完成服务器自动选择，再渲染快捷下载、上传、文本处理或分享页面。
  useEffect(() => {
    if (!isLoaded || Platform.OS !== 'android') return;

    let cancelled = false;
    const prepareQuickAction = async (): Promise<void> => {
      try {
        await networkAutoSwitchService.ensureCurrentServer();
      } catch (error) {
        console.error('[QuickActionApp] Network auto-switch preflight failed:', error);
      }

      if (cancelled) return;
      // 后台任务由 Headless 初始化；请求失败或未就绪不阻塞用户操作界面。
      void requestServiceRuntime().catch((error) => {
        console.error('[QuickActionApp] Runtime initialization failed:', error);
      });
      setIsServerSelectionComplete(true);
    };

    prepareQuickAction().catch(() => {
      if (!cancelled) setIsServerSelectionComplete(true);
    });

    return () => {
      cancelled = true;
    };
  }, [isLoaded]);

  const handleComplete = useCallback(() => {
    BackHandler.exitApp();
  }, []);

  if (!isLoaded || !isServerSelectionComplete) return null;

  // Share mode: receive shared content via native incoming session
  if (shareMode) {
    const resolvedSession: IncomingSessionMeta = activeShareSession ?? {
      sessionId: '',
      kind: 'empty',
      itemCount: 0,
    };
    return (
      <GestureHandlerRootView style={styles.container}>
        <I18nProvider>
          <ThemeProvider systemColorSchemeOverride={systemTheme}>
            <StatusBar backgroundColor="transparent" translucent barStyle="light-content" />
            <DirectShareReceiveScreen
              key={resolvedSession.sessionId || 'empty'}
              session={resolvedSession}
              onComplete={handleComplete}
              overlayMode
            />
          </ThemeProvider>
        </I18nProvider>
      </GestureHandlerRootView>
    );
  }

  // Process text mode: upload selected text
  if (text) {
    return (
      <GestureHandlerRootView style={styles.container}>
        <I18nProvider>
          <ThemeProvider systemColorSchemeOverride={systemTheme}>
            <StatusBar backgroundColor="transparent" translucent barStyle="light-content" />
            <ProcessTextScreen text={text} onComplete={handleComplete} overlayMode />
          </ThemeProvider>
        </I18nProvider>
      </GestureHandlerRootView>
    );
  }

  // Quick tile mode: download/upload
  return (
    <GestureHandlerRootView style={styles.container}>
      <I18nProvider>
        <ThemeProvider systemColorSchemeOverride={systemTheme}>
          <StatusBar backgroundColor="transparent" translucent barStyle="light-content" />
          <QuickTileLoadingScreen
            direction={syncDirection}
            onLoadingComplete={handleComplete}
            overlayMode
          />
        </ThemeProvider>
      </I18nProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
