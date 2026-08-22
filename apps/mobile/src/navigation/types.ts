export type MainTabParamList = {
  Home: undefined;
  Labs: undefined;
  SnapAction: undefined;
  Log: undefined;
  Settings: undefined;
};

export type LabsStackParamList = {
  Labs: undefined;
  LabRecordForm: { readonly recordId?: string } | undefined;
  LabRecordDetail: { readonly recordId: string };
};

export type RootStackParamList = {
  MainTabs: undefined;
};
