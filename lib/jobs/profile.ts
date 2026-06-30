/**
 * PROFILE_PASS job handler (intake): build a Perplexity research profile for a private / pre-IPO name.
 */
import { runPrivateProfile, type ProfileOutcome } from "../engines/private_profile";

export interface ProfileJobData { company_id: string }

export async function handleProfilePass(data: ProfileJobData): Promise<ProfileOutcome> {
  return runPrivateProfile(data.company_id);
}
