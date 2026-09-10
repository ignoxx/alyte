/**
 * Runner entry point for the isolated date-exclusion experiment.
 *
 * The wrapper forwards the runner's normal report/output arguments and forces the private
 * experiment selector through the baseline adapter API. It does not add shell arguments or alter
 * the faithful adapter's default model-enabled mode.
 */
import { main } from './alyte-service-baseline.ts';

void main({ experiment: 'date-exclusion-v1' });
