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
  LabReportImport: undefined;
  LabReportDetail: { readonly reportId: string };
  SanitizedReportEditor: { readonly reportId: string };
  LabRecordForm: { readonly recordId?: string } | undefined;
  LabRecordDetail: { readonly recordId: string };
};

export type LogStackParamList = {
  LogRoot: undefined;
  IntakeEntry: { readonly eventId?: string } | undefined;
};

export type RootStackParamList = {
  MainTabs: NavigatorScreenParams<MainTabParamList> | undefined;
  SnapCapture: undefined;
};
