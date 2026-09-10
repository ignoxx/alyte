import type { NavigatorScreenParams } from '@react-navigation/native';

export type HomeStackParamList = {
  HomeRoot: undefined;
};

export type SettingsStackParamList = {
  SettingsRoot: undefined;
  CloudAccount: undefined;
  AppLock: undefined;
  PrivacyStorage: undefined;
  SupportFaq: undefined;
  Diagnostics: undefined;
  DeleteLocalData: { readonly mode: 'health-data' | 'app-reset' };
};

export type MainTabParamList = {
  Home: NavigatorScreenParams<HomeStackParamList> | undefined;
  Labs: NavigatorScreenParams<LabsStackParamList> | undefined;
  SnapAction: undefined;
  Log: NavigatorScreenParams<LogStackParamList> | undefined;
  Settings: NavigatorScreenParams<SettingsStackParamList> | undefined;
};

export type LabsStackParamList = {
  LabsRoot: undefined;
  LabReportDetail: { readonly reportId: string };
  ExtractionDraft: {
    readonly reportId: string;
    readonly draftId: string;
  };
  LabRecordDetail: { readonly recordId: string };
  BiomarkerHistory: { readonly biomarkerId: string };
  MeasurementDetail: { readonly recordId: string; readonly measurementId: string };
};

export type LogStackParamList = {
  LogRoot: undefined;
  IntakeEntry: { readonly eventId?: string } | undefined;
};

export type RootStackParamList = {
  MainTabs: NavigatorScreenParams<MainTabParamList> | undefined;
  CloudPaywall: { readonly operation: 'snap' | 'report' | 'settings' };
  ImportPackSetup: undefined;
  ReportImport: undefined;
  SnapCapture: undefined;
  PrivacyWorkspace: { readonly reportId: string };
  OriginalSourcePreview: {
    readonly reportId: string;
    readonly pageIndex?: number;
    /** Optional normalized source location for a measurement. */
    readonly boundingBox?: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
  };
  ExtractionProgress: {
    readonly reportId: string;
    readonly mode?: 'start' | 'reprocess' | 'improve';
  };
  ExtractionMeasurementEditor: {
    readonly reportId: string;
    readonly draftId: string;
    readonly rowId: string;
    /** Present only when the user starts the focused "Review remaining" sequence. */
    readonly reviewQueue?: readonly string[];
  };
  LabRecordForm: { readonly recordId?: string } | undefined;
  SanitizedSourcePreview: {
    readonly reportId: string;
    readonly pageIndex: number;
    readonly boundingBox: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
  };
  MeasurementCorrection: { readonly recordId: string; readonly measurementId: string };
  LabDeletion: { readonly recordId: string; readonly measurementId?: string };
  RecordSourcePreview: { readonly recordId: string; readonly measurementId: string };
  FullExport: undefined;
};
