import { defineConfig } from '@neon/config/v1'

export default defineConfig({
  branch: (branch) => {
    if (branch.exists) return {}
    return {
      postgres: {
        computeSettings: {
          autoscalingLimitMinCu: 32,
          autoscalingLimitMaxCu: 32,
          suspendTimeout: false,
        },
      },
    }
  },
})
