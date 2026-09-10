import { KuaizuEnergyProvider, type KuaizuAdapterOptions } from "./kuaizu.js";
import type { EnergyProviderAdapter } from "./types.js";

export class EnergyProviderRegistry {
  private readonly adapters = new Map<string, EnergyProviderAdapter>();

  constructor(adapters: readonly EnergyProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: EnergyProviderAdapter): void {
    assertProviderType(adapter.type);
    if (this.adapters.has(adapter.type)) {
      throw new Error(`Energy provider adapter is already registered: ${adapter.type}`);
    }
    this.adapters.set(adapter.type, adapter);
  }

  get(type: string): EnergyProviderAdapter | null {
    return this.adapters.get(type) ?? null;
  }

  has(type: string): boolean {
    return this.adapters.has(type);
  }

  listTypes(): readonly string[] {
    return [...this.adapters.keys()].sort();
  }
}

export function createDefaultEnergyProviderRegistry(
  kuaizuOptions: KuaizuAdapterOptions = {}
): EnergyProviderRegistry {
  return new EnergyProviderRegistry([new KuaizuEnergyProvider(kuaizuOptions)]);
}

function assertProviderType(type: string): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(type)) throw new Error("Invalid energy provider type");
}
