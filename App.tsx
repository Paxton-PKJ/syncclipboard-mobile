import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  StyleSheet,
  Linking,
  ToastAndroid,
  StatusBar,
  View,
  Platform,
  type NativeSyntheticEvent,
} from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import { ThemeProvider } from './src/contexts/ThemeContext';
import { I18nProvider } from './src/contexts/I18nContext';
import '@/i18n';
import { AppNavigator } from './src/navigation/AppNavigator';
import { QuickTileLoadingScreen } from './src/screens/QuickTileLoadingScreen';
import { DropHoverOverlay, DropUploadOverlay } from './src/components/DropReceiveOverlay';
import { SyncDirection } from './src/types/sync';
import { useSettingsStore } from './src/stores';
import { initLogger } from './src/utils/Logger';
import { useTheme } from './src/hooks/useTheme';
import { setDynamicShortcuts } from 'shortcut';
import {
  DropTarget,
  moveTaskToBack,
  setExcludeFromRecents,
  type DropDragStateEvent,
  type IncomingSessionMeta,
} from 'native-util';
import { networkAutoSwitchService } from './src/services/NetworkAutoSwitchService';

const QUICK_UPLOAD_URL = 'syncclipboard://quick-upload';
const QUICK_DOWNLOAD_URL = 'syncclipboard://quick-download';

function parseQuickTileUrl(url: string | null): {
  isQuickTile: boolean;
  fromForeground: boolean;
  direction: SyncDirection;
} {
  if (!url) return { isQuickTile: false, fromForeground: false, direction: SyncDirection.Download };
  const fromForeground = url.includes('fg=1');
  if (url.startsWith(QUICK_UPLOAD_URL)) {
    return { isQuickTile: true, fromForeground, direction: SyncDirection.Upload };
  }
  if (url.startsWith(QUICK_DOWNLOAD_URL)) {
    return { isQuickTile: true, fromForeground, direction: SyncDirection.Download };
  }
  return { isQuickTile: false, fromForeground: false, direction: SyncDirection.Download };
}

async function runOverlayNetworkPreflight(): Promise<void> {
  try {
    await networkAutoSwitchService.ensureCurrentServer();
  } catch (error) {
    console.error('[App] Overlay network auto-switch preflight failed:', error);
  }
}

type AppMode = 'checking' | 'home';

export default function App() {
  const [appMode, setAppMode] = useState<AppMode>('checking');
  // 快速操作覆盖层：始终以 overlay 形式显示，不卸载 AppNavigator/HomeScreen
  const [quickActionOverlay, setQuickActionOverlay] = useState<{
    direction: SyncDirection;
    exitAfterSync: boolean;
  } | null>(null);
  const [dropDragState, setDropDragState] = useState<DropDragStateEvent>({
    active: false,
    entered: false,
  });
  const [activeDropSession, setActiveDropSession] = useState<IncomingSessionMeta | null>(null);
  const { config, loadConfig, isLoaded, getActiveServer } = useSettingsStore();

  const activeServer = getActiveServer();
  const dropEnabled = appMode === 'home' && !quickActionOverlay && !activeDropSession;

  useEffect(() => {
    initLogger();
    setDynamicShortcuts();
  }, []);

  useEffect(() => {
    if (!isLoaded) {
      loadConfig();
    }
  }, [isLoaded, loadConfig]);

  // 应用启动时恢复「最近任务隐藏」设置（仅 Android）
  useEffect(() => {
    if (!isLoaded) return;
    if (Platform.OS === 'android' && config?.hideFromRecents) {
      setExcludeFromRecents(true);
    }
  }, [isLoaded, config?.hideFromRecents]);

  useEffect(() => {
    if (!dropEnabled) {
      setDropDragState((prev) =>
        !prev.active && !prev.entered ? prev : { active: false, entered: false }
      );
    }
  }, [dropEnabled]);

  useEffect(() => {
    if (!isLoaded) return;

    // Cold start: app launched via URL scheme
    // 冷启动时 getInitialURL 可能为空，需要重试一次
    const getInitialUrlWithRetry = async (): Promise<string | null> => {
      let url = await Linking.getInitialURL();
      if (!url) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        url = await Linking.getInitialURL();
      }
      return url;
    };

    getInitialUrlWithRetry().then(async (url) => {
      if (config?.debugUrlScheme) {
        ToastAndroid.show(`getInitialURL: ${url ?? 'null'}`, ToastAndroid.LONG);
      }
      const { isQuickTile, fromForeground, direction } = parseQuickTileUrl(url);
      // 同步运行时由进程入口管理，此处只负责显示主界面。
      setAppMode('home');
      if (isQuickTile) {
        await runOverlayNetworkPreflight();
        // fg=1 完成后留在 app，fg=0/无fg 完成后退出
        setQuickActionOverlay({ direction, exitAfterSync: !fromForeground });
      }
    });

    // Hot start: app already running, receives URL deep link event
    const urlSub = Linking.addEventListener('url', ({ url }) => {
      if (config?.debugUrlScheme) {
        ToastAndroid.show(`addEventListener url: ${url ?? 'null'}`, ToastAndroid.LONG);
      }
      const { isQuickTile, fromForeground, direction } = parseQuickTileUrl(url);
      if (isQuickTile) {
        runOverlayNetworkPreflight().then(() => {
          // fg=1 完成后留在 app，fg=0/无fg 完成后退出
          setQuickActionOverlay({ direction, exitAfterSync: !fromForeground });
        });
      }
    });

    return () => urlSub.remove();
  }, [isLoaded, config?.debugUrlScheme]);

  const handleDropDragStateChange = useCallback(
    (event: NativeSyntheticEvent<DropDragStateEvent>) => {
      const next = event.nativeEvent;
      setDropDragState((prev) =>
        prev.active === next.active && prev.entered === next.entered
          ? prev
          : { active: next.active, entered: next.entered }
      );
    },
    []
  );

  const handleDropReceived = useCallback((event: NativeSyntheticEvent<IncomingSessionMeta>) => {
    const session = event.nativeEvent;
    setDropDragState((prev) =>
      !prev.active && !prev.entered ? prev : { active: false, entered: false }
    );
    if (session.kind === 'empty' || (session.kind !== 'unsupported_mixed' && !session.sessionId)) {
      return;
    }
    setActiveDropSession(
      session.kind === 'unsupported_mixed' && !session.sessionId
        ? { ...session, sessionId: `unsupported-mixed-${Date.now()}` }
        : session
    );
  }, []);

  const handleDropUploadComplete = useCallback(() => {
    setActiveDropSession(null);
  }, []);

  return (
    <GestureHandlerRootView style={styles.container}>
      <ThemeProvider>
        <I18nProvider>
          <ThemedStatusBar />
          <DropTarget
            style={styles.container}
            enabled={dropEnabled}
            onDragStateChange={handleDropDragStateChange}
            onDropReceived={handleDropReceived}
          >
            {appMode === 'checking' ? null : <AppNavigator />}
          </DropTarget>
          <DropHoverOverlay
            visible={dropEnabled && dropDragState.active}
            entered={dropDragState.entered}
            hasActiveServer={!!activeServer}
          />
          {activeDropSession && (
            <View style={StyleSheet.absoluteFill}>
              <DropUploadOverlay
                key={activeDropSession.sessionId}
                session={activeDropSession}
                onComplete={handleDropUploadComplete}
              />
            </View>
          )}
          {quickActionOverlay && (
            <View style={StyleSheet.absoluteFill}>
              <QuickTileLoadingScreen
                direction={quickActionOverlay.direction}
                onLoadingComplete={() => {
                  const shouldExit = quickActionOverlay.exitAfterSync;
                  setQuickActionOverlay(null);
                  if (shouldExit) {
                    // 将快捷操作任务移到后台，保留返回主界面的导航状态
                    moveTaskToBack();
                  }
                }}
                overlayMode
              />
            </View>
          )}
        </I18nProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

function ThemedStatusBar() {
  const { theme } = useTheme();
  return (
    <StatusBar
      barStyle={theme.isDark ? 'light-content' : 'dark-content'}
      backgroundColor={theme.colors.surface}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
