import type { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParamList = {
  Home: undefined;
  Labs: undefined;
  SnapAction: undefined;
  Log: undefined;
  Settings: undefined;
};

export type LabsStackParamList = {
  Labs: undefined;
  LabReportImport: undefined;
  LabReportDetail: { readonly reportId: string };
  SanitizedReportEditor: { readonly reportId: string };
  LabRecordForm: { readonly recordId?: string } | undefined;
  LabRecordDetail: { readonly recordId: string };
};

export type LogStackParamList = {
  Log: undefined;
  IntakeEntry: { readonly eventId?: string } | undefined;
};

export type RootStackParamList = {
  MainTabs: NavigatorScreenParams<MainTabParamList> | undefined;
  SnapCapture: undefined;
};
