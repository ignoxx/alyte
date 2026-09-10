/**
 * Runner entry point for the evaluation-only Vision/layout experiment.
 *
 * Every PDF page is routed through the native Vision OCR seam, including selectable-text pages.
 * The unchanged report-service then performs its deterministic geometry reconstruction with the
 * document model disabled. This file must never be imported by the mobile production bundle.
 */
import { main } from './alyte-service-baseline.ts';

void main({
  deterministicOnly: true,
  experiment: 'vision-geometry-v1',
  forceVision: true,
});
