import type { NavigatorScreenParams } from '@react-navigation/native';

export type HomeStackParamList = {
  HomeRoot: undefined;
};

export type SettingsStackParamList = {
  SettingsRoot: undefined;
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
  LabRecordForm: { readonly recordId?: string } | undefined;
  LabRecordDetail: { readonly recordId: string };
};

export type LogStackParamList = {
  LogRoot: undefined;
  IntakeEntry: { readonly eventId?: string } | undefined;
};

export type RootStackParamList = {
  MainTabs: NavigatorScreenParams<MainTabParamList> | undefined;
  ReportImport: undefined;
  SnapCapture: undefined;
  PrivacyWorkspace: { readonly reportId: string };
  ExtractionMeasurementEditor: {
    readonly reportId: string;
    readonly draftId: string;
    readonly rowId: string;
  };
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
};
