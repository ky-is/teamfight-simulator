import { markRaw } from 'vue'

import { BonusKey, DamageType } from '@tacticians-academy/academy-library'
import type { ChampionData, ChampionSpellData, EffectVariables, ItemData, SpellCalculation, TraitData } from '@tacticians-academy/academy-library'
import { AugmentGroupKey } from '@tacticians-academy/academy-library/dist/set6/augments'
import { ChampionKey } from '@tacticians-academy/academy-library/dist/set6/champions'
import { ItemKey } from '@tacticians-academy/academy-library/dist/set6/items'
import { TraitKey } from '@tacticians-academy/academy-library/dist/set6/traits'

import { HexEffect } from '#/game/effects/HexEffect'
import type { HexEffectData } from '#/game/effects/HexEffect'
import type { AttackBounce, AttackEffectData } from '#/game/effects/GameEffect'
import { ProjectileEffect } from '#/game/effects/ProjectileEffect'
import type { ProjectileEffectData } from '#/game/effects/ProjectileEffect'
import { ShapeEffect, ShapeEffectVisualRectangle } from '#/game/effects/ShapeEffect'
import type { ShapeEffectData } from '#/game/effects/ShapeEffect'
import { TargetEffect } from '#/game/effects/TargetEffect'
import type { TargetEffectData } from '#/game/effects/TargetEffect'
import { getCoordFrom, gameOver, getters, state, setData } from '#/game/store'

import { getAliveUnitsOfTeamWithTrait, getAttackableUnitsOfTeam, getBestAsMax, getBestRandomAsMax, thresholdCheck } from '#/helpers/abilityUtils'
import { getAngleBetween } from '#/helpers/angles'
import { containsHex, coordinateDistanceSquared, getClosestHexAvailableTo, getHexRing, getSurroundingWithin, hexDistanceFrom, isInBackLines, isSameHex, recursivePathTo } from '#/helpers/boardUtils'
import { calculateItemBonuses, calculateSynergyBonuses, createDamageCalculation, solveSpellCalculationFrom } from '#/helpers/calculate'
import { BACKLINE_JUMP_MS, BOARD_ROW_COUNT, BOARD_ROW_PER_SIDE_COUNT, DEFAULT_MANA_LOCK_MS, HEX_PROPORTION, HEX_PROPORTION_PER_LEAGUEUNIT, MAX_HEX_COUNT } from '#/helpers/constants'
import { saveUnits } from '#/helpers/storage'
import { SpellKey, DamageSourceType, StatusEffectType, NEGATIVE_STATUS_EFFECTS } from '#/helpers/types'
import type { BleedData, BonusEntry, BonusLabelKey, BonusScaling, BonusVariable, ChampionFns, DamageModifier, HexCoord, ShieldEntry, StarLevel, StatusEffect, StatusEffectData, TeamNumber, ShieldData, SynergyData } from '#/helpers/types'
import { uniqueIdentifier } from '#/helpers/utils'

let instanceIndex = 0

function stageIndex() {
	return Math.min(Math.max(2, state.stageNumber), 5) - 2
}

interface EmpoweredAuto {
	id?: BonusLabelKey
	amount: number
	expiresAtMS?: DOMHighResTimeStamp
	bounce?: AttackBounce
	damageCalculation?: SpellCalculation
	damageModifier?: DamageModifier
	statusEffects?: StatusEffectData[]
}

export class ChampionUnit {
	instanceID: string
	name: string
	startHex: HexCoord
	team: TeamNumber = 0
	starLevel: StarLevel
	data: ChampionData

	activeHex: HexCoord
	coord: HexCoord
	dead = false
	resurrecting = false
	target: ChampionUnit | null = null // eslint-disable-line no-use-before-define
	wasInRangeOfTarget = false
	movesBeforeDroppingTarget = 0
	mana = 0
	health = 0
	healthMax = 0
	starMultiplier = 1
	isStarLocked: boolean
	fixedAS: number | undefined
	instantAttack: boolean
	wasSpawned = false

	hitBy: string[] = []
	statusEffects = {} as Record<StatusEffectType, StatusEffect>

	attackStartAtMS: DOMHighResTimeStamp = 0
	moving = false
	customMoveSpeed: number | undefined
	performActionUntilMS: DOMHighResTimeStamp = 0
	manaLockUntilMS: DOMHighResTimeStamp = 0
	items: ItemData[] = []
	traits: TraitData[] = []
	activeSynergies: SynergyData[] = []
	transformIndex = 0
	basicAttackCount = 0
	castCount = 0

	empoweredAutos: Set<EmpoweredAuto> = new Set()
	championEffects: ChampionFns | undefined

	bonuses: BonusEntry[] = []
	scalings = new Set<BonusScaling>()
	shields: ShieldEntry[] = []
	bleeds = new Set<BleedData>()

	pendingBonuses = new Set<[activatesAtMS: DOMHighResTimeStamp, label: BonusLabelKey, variables: BonusVariable[]]>()

	constructor(name: string, hex: HexCoord, starLevel: StarLevel) {
		this.instanceID = `c${instanceIndex += 1}`
		const stats = setData.champions.find(unit => unit.name === name) ?? setData.champions[0]
		this.isStarLocked = stats.isSpawn && name !== ChampionKey.TrainingDummy
		this.data = markRaw(stats)
		this.name = name
		this.starLevel = starLevel
		this.instantAttack = this.data.stats.range <= 1
		this.startHex = [...hex]
		this.activeHex = [...hex]
		this.coord = this.getCoord()
		this.reposition(hex)

		for (const effectType in StatusEffectType) {
			this.statusEffects[effectType as StatusEffectType] = {
				active: false,
				expiresAtMS: 0,
				amount: 0,
			}
		}
	}

	genericReset() {
		this.resetPre([[], []])
		this.resetPost()
	}
	resetPre(synergiesByTeam: SynergyData[][]) {
		this.championEffects = setData.championEffects[this.name as ChampionKey]
		this.pendingBonuses.clear()
		this.bleeds.clear()
		this.hitBy = []
		this.empoweredAutos.clear()

		Object.keys(this.statusEffects).forEach(effectType => {
			const statusEffect = this.statusEffects[effectType as StatusEffectType]
			statusEffect.active = false
			statusEffect.amount = 0
			statusEffect.expiresAtMS = 0
		})

		this.starMultiplier = Math.pow(1.8, this.starLevel - 1)
		this.dead = false
		this.target = null
		this.setActiveHex(this.startHex)
		const coord = this.getCoord()
		this.coord[0] = coord[0]
		this.coord[1] = coord[1]
		this.moving = false
		this.attackStartAtMS = 0
		this.customMoveSpeed = undefined
		this.performActionUntilMS = 0
		this.manaLockUntilMS = 0
		this.basicAttackCount = 0
		this.castCount = 0
		if (this.hasTrait(TraitKey.Transformer)) {
			const col = this.activeHex[1]
			this.transformIndex = isInBackLines(this) ? 1 : 0
		} else {
			this.transformIndex = 0
		}

		this.scalings.clear()
		this.shields = []
		const unitTraitKeys = (this.data.traits as TraitKey[]).concat(this.items.filter(item => item.name.endsWith(' Emblem')).map(item => item.name.replace(' Emblem', '') as TraitKey))
		this.traits = Array.from(new Set(unitTraitKeys)).map(traitKey => setData.traits.find(trait => trait.name === traitKey)).filter((trait): trait is TraitData => !!trait)
		const teamSynergies = synergiesByTeam[this.team]
		this.activeSynergies = teamSynergies.filter(({ key, activeEffect }) => !!activeEffect && this.hasTrait(key))
		const synergyTraitBonuses = calculateSynergyBonuses(this, teamSynergies, unitTraitKeys)
		const itemBonuses = calculateItemBonuses(this, this.items)
		this.bonuses = [...synergyTraitBonuses, ...itemBonuses]
	}
	resetPost() {
		this.setMana(this.data.stats.initialMana + this.getBonuses(BonusKey.Mana))
		this.health = this.baseHP() + this.getBonusVariants(BonusKey.Health)
		this.healthMax = this.health
		this.fixedAS = this.getSpellVariableIfExists(this.getCurrentSpell(), SpellKey.AttackSpeed)
	}

	baseHP() {
		const hpStat = this.data.stats.hp ?? [1500, 1800, 2100, 2500][stageIndex()] // ??TFT_VoidSpawn
		return hpStat * this.starMultiplier
	}

	addBonuses(key: BonusLabelKey, ...bonuses: BonusVariable[]) {
		this.bonuses.push([key, bonuses])
	}

	canAttackTarget() {
		return this.target ? this.wasInRangeOfTarget && this.target.isAttackable() : false
	}

	setTarget(unit: ChampionUnit | null | undefined) {
		this.target = unit ?? null
		this.wasInRangeOfTarget = false
		if (unit) {
			this.movesBeforeDroppingTarget = 3
		}
		// console.log(this.name, this.team, 'targets at', this.cachedTargetDistance, 'hexes', this.target.name, this.target.team)
	}
	checkInRangeOfTarget() {
		return this.target ? this.hexDistanceTo(this.target) <= this.range() : false
	}
	updateTarget() {
		if (this.target != null && (!this.target.isAttackable() || (this.movesBeforeDroppingTarget <= 0 && !this.checkInRangeOfTarget()))) {
			this.setTarget(null)
		}
		if (this.target == null) {
			const target = getBestRandomAsMax(false, getAttackableUnitsOfTeam(this.opposingTeam()), (unit) => this.hexDistanceTo(unit))
			if (target != null) {
				this.setTarget(target)
			}
		}
		if (this.target) {
			this.wasInRangeOfTarget = this.checkInRangeOfTarget()
			if (this.wasInRangeOfTarget) {
				this.movesBeforeDroppingTarget = 3
			}
		}
	}

	isNthBasicAttack(n: number) {
		return this.basicAttackCount % n === 1
	}

	updateAttack(elapsedMS: DOMHighResTimeStamp) {
		if (this.target == null) {
			return
		}
		let attackSpeed = this.attackSpeed()
		const attackSpeedSlow = this.getStatusEffect(elapsedMS, StatusEffectType.attackSpeedSlow)
		if (attackSpeedSlow != null) {
			attackSpeed *= 1 - attackSpeedSlow / 100
		}
		const msBetweenAttacks = 1000 / attackSpeed
		if (elapsedMS < this.attackStartAtMS + msBetweenAttacks) {
			return
		}
		if (this.attackStartAtMS <= 0) {
			this.attackStartAtMS = elapsedMS
		} else {
			this.basicAttackCount += 1
			const canReProcAttack = this.attackStartAtMS > 1
			const damageCalculation = createDamageCalculation(BonusKey.AttackDamage, 1, undefined, BonusKey.AttackDamage, false, 1)
			const passiveFn = this.championEffects?.passive
			const damageModifier: DamageModifier = {
				increase: 0,
				multiplier: 0,
				critChance: 0,
			}
			const statusEffects: StatusEffectData[] = []
			const bonusCalculations: SpellCalculation[] = []
			let bounce: AttackBounce | undefined
			this.empoweredAutos.forEach(empower => {
				if (empower.expiresAtMS != null && elapsedMS >= empower.expiresAtMS) {
					this.empoweredAutos.delete(empower)
					return
				}
				Object.keys(damageModifier).forEach((modifier) => {
					const modifierKey = modifier as keyof DamageModifier
					damageModifier[modifierKey]! += empower.damageModifier?.[modifierKey] ?? 0
				})
				if (empower.damageCalculation) {
					bonusCalculations.push(empower.damageCalculation)
				}
				if (empower.statusEffects) {
					statusEffects.push(...empower.statusEffects)
				}
				if (empower.bounce) {
					bounce = Object.assign({}, empower.bounce)
				}
			})
			const windupMS = msBetweenAttacks / 4 //TODO calculate from data
			const damageSourceType = DamageSourceType.attack
			if (this.instantAttack) {
				this.queueTargetEffect(elapsedMS, undefined, {
					activatesAfterMS: windupMS,
					damageSourceType,
					damageCalculation,
					bonusCalculations,
					damageModifier,
					statusEffects,
					bounce,
					onActivate: (elapsedMS, source) => {
						source.gainMana(elapsedMS, 10 + source.getBonuses(BonusKey.ManaRestorePerAttack))
						if (source.data.passive && source.target && source.readyToCast()) {
							passiveFn?.(elapsedMS, source.data.passive, source.target, source)
							source.postCast(elapsedMS, canReProcAttack)
						}
						statusEffects.forEach(([key, statusEffect]) => {
							source.target?.applyStatusEffect(elapsedMS, key, statusEffect.durationMS, statusEffect.amount)
						})
					},
				})
				this.attackStartAtMS = elapsedMS
			} else {
				const source = this
				this.queueProjectileEffect(elapsedMS, undefined, {
					startsAfterMS: windupMS,
					missile: {
						speedInitial: this.data.basicAttackMissileSpeed ?? this.data.critAttackMissileSpeed ?? 1000, //TODO crits
					},
					damageSourceType,
					target: this.target,
					damageCalculation: damageCalculation,
					bonusCalculations,
					damageModifier,
					statusEffects,
					bounce,
					onCollision(elapsedMS, unit) {
						if (source.data.passive && source.readyToCast()) {
							passiveFn?.(elapsedMS, source.data.passive, unit, source)
							source.postCast(elapsedMS, canReProcAttack)
						}
						source.gainMana(elapsedMS, 10 + source.getBonuses(BonusKey.ManaRestorePerAttack))
					},
				})
			}
			this.empoweredAutos.forEach(empoweredAuto => {
				if (empoweredAuto.amount > 1) {
					empoweredAuto.amount -= 1
				} else {
					this.empoweredAutos.delete(empoweredAuto)
				}
			})
			this.items.forEach((item, index) => setData.itemEffects[item.id as ItemKey]?.basicAttack?.(elapsedMS, item, uniqueIdentifier(index, item), this.target!, this, canReProcAttack))
			this.activeSynergies.forEach(({ key, activeEffect }) => setData.traitEffects[key]?.basicAttack?.(activeEffect!, this.target!, this, canReProcAttack))
		}
	}

	addBleedIfStrongerThan(sourceID: string, bleed: BleedData) {
		const oldBleed = this.getBleed(sourceID)
		if (oldBleed) {
			if (oldBleed.remainingIterations >= bleed.remainingIterations) {
				return
			}
			this.bleeds.delete(oldBleed)
		}
		this.bleeds.add({...bleed})
	}

	getBleed(sourceID: string) {
		return Array.from(this.bleeds).find(bleed => bleed.sourceID === sourceID)
	}

	updateBleeds(elapsedMS: DOMHighResTimeStamp) {
		this.bleeds.forEach(bleed => {
			if (elapsedMS >= bleed.activatesAtMS) {
				bleed.activatesAtMS += bleed.repeatsEveryMS
				bleed.remainingIterations -= 1
				this.damage(elapsedMS, false, bleed.source, DamageSourceType.bonus, bleed.damageCalculation, false, bleed.damageModifier)
				if (bleed.remainingIterations <= 0) {
					this.bleeds.delete(bleed)
				}
			}
		})
	}

	updateBonuses(elapsedMS: DOMHighResTimeStamp) {
		this.bonuses.forEach(bonus => bonus[1] = bonus[1].filter(variable => variable[2] == null || variable[2] > elapsedMS))
	}

	updateRegen(elapsedMS: DOMHighResTimeStamp) {
		this.scalings.forEach(scaling => {
			if (scaling.activatedAtMS === 0) {
				scaling.activatedAtMS = elapsedMS
				return
			}
			if (scaling.expiresAfterMS != null && scaling.activatedAtMS + scaling.expiresAfterMS >= elapsedMS) {
				this.scalings.delete(scaling)
				return
			}
			if (elapsedMS < scaling.activatedAtMS + scaling.intervalSeconds * 1000) {
				return
			}
			scaling.activatedAtMS = elapsedMS
			const bonuses: BonusVariable[] = []
			for (const stat of scaling.stats) {
				const amount = scaling.intervalAmount ?? scaling.calculateAmount!(elapsedMS)
				if (stat === BonusKey.Health) {
					this.gainHealth(elapsedMS, scaling.source, amount, false)
				} else if (stat === BonusKey.Mana) {
					if (this.manaLockUntilMS < elapsedMS) {
						this.addMana(amount)
					}
				} else {
					bonuses.push([stat, amount])
				}
			}
			if (bonuses.length) {
				this.addBonuses(scaling.sourceID, ...bonuses)
			}
		})
	}

	updateShields(elapsedMS: DOMHighResTimeStamp) {
		this.shields.forEach(shield => {
			if (shield.activated !== false && shield.expiresAtMS != null && elapsedMS >= shield.expiresAtMS) {
				shield.onRemoved?.(elapsedMS, shield)
				shield.activated = false
			}

			if (shield.activated !== true) {
				if (shield.activatesAtMS != null) {
					if (elapsedMS >= shield.activatesAtMS) {
						shield.activated = true
						if (shield.repeatsEveryMS != null) {
							shield.activatesAtMS += shield.repeatsEveryMS
							if (shield.expiresAtMS != null) {
								shield.expiresAtMS += shield.repeatsEveryMS
							}
						}
						if (shield.repeatAmount != null) {
							shield.amount = shield.repeatAmount
						}
					}
				} else if (shield.activated === undefined) {
					shield.activated = true
				}
			}
		})
	}

	rawCritChance(damageModifier?: DamageModifier) {
		return (this.data.stats.critChance ?? 0) + (damageModifier?.critChance != null ? damageModifier.critChance / 100 : 0) + this.getBonuses(BonusKey.CritChance) / 100
	}
	critChance(damageModifier?: DamageModifier) {
		return Math.min(1, this.rawCritChance(damageModifier))
	}
	critMultiplier(damageModifier?: DamageModifier) {
		const excessCritChance = this.rawCritChance(damageModifier) - 1
		return this.data.stats.critMultiplier + Math.max(0, excessCritChance) + this.getBonuses(BonusKey.CritMultiplier) / 100
	}
	critReduction() {
		return this.getBonuses(BonusKey.CritReduction) / 100
	}

	getNextHex() {
		if (!this.target) {
			return undefined
		}
		const occupiedHexes: HexCoord[] = state.units
			.filter(unit => unit.hasCollision())
			.map(unit => unit.activeHex)
		return recursivePathTo(this.activeHex, this.target.activeHex, occupiedHexes, [this.target.activeHex], [this.target.activeHex])
	}
	updateMove(elapsedMS: DOMHighResTimeStamp, diffMS: DOMHighResTimeStamp) {
		if (!this.moving) {
			if (this.canAttackTarget() || !this.canPerformAction(elapsedMS)) {
				return false
			}
			const nextHex = this.getNextHex()
			if (!nextHex) {
				return false
			}
			this.moving = true
			this.setActiveHex(nextHex)
		}

		const [currentX, currentY] = this.coord
		const [targetX, targetY] = getCoordFrom(this.activeHex)
		const distanceX = targetX - currentX
		const distanceY = targetY - currentY
		const diffDistance = diffMS / 1000 * this.moveSpeed() * HEX_PROPORTION_PER_LEAGUEUNIT
		if (Math.abs(distanceX) <= diffDistance && Math.abs(distanceY) <= diffDistance) {
			this.moving = false
			this.customMoveSpeed = undefined
			this.coord[0] = targetX
			this.coord[1] = targetY
		} else {
			const angle = Math.atan2(distanceY, distanceX)
			this.coord[0] += Math.cos(angle) * diffDistance
			this.coord[1] += Math.sin(angle) * diffDistance
		}
		return true
	}

	getStatusEffect(elapsedMS: DOMHighResTimeStamp, effectType: StatusEffectType) {
		const statusEffect = this.statusEffects[effectType]
		if (statusEffect.active && elapsedMS < statusEffect.expiresAtMS) {
			return statusEffect.amount ?? 0
		}
		return undefined
	}
	applyStatusEffect(elapsedMS: DOMHighResTimeStamp, effectType: StatusEffectType, durationMS: DOMHighResTimeStamp, amount: number = 1) {
		const expireAtMS = elapsedMS + durationMS
		const statusEffect = this.statusEffects[effectType]
		if (!statusEffect.active || expireAtMS > statusEffect.expiresAtMS) {
			statusEffect.active = true
			statusEffect.expiresAtMS = expireAtMS
			statusEffect.amount = amount
		}
	}

	updateStatusEffects(elapsedMS: DOMHighResTimeStamp) {
		for (const effectType in this.statusEffects) {
			const statusEffect = this.statusEffects[effectType as StatusEffectType]
			if (statusEffect.active) {
				if (elapsedMS >= statusEffect.expiresAtMS) {
					statusEffect.active = false
				} else if (effectType === StatusEffectType.stunned && statusEffect.amount > 0) {
					if (this.health <= statusEffect.amount) {
						statusEffect.active = false
					}
				}
			}
		}
	}

	opposingTeam(): TeamNumber {
		return 1 - this.team as TeamNumber
	}

	readyToCast(): boolean {
		return this.mana >= this.manaMax()
	}
	castAbility(elapsedMS: DOMHighResTimeStamp, initialCast: boolean) {
		const spell = this.getCurrentSpell()
		if (spell) {
			const castFn = this.championEffects?.cast
			if (castFn && !castFn(elapsedMS, spell, this)) {
				return false
			}
		}
		this.postCast(elapsedMS, initialCast)
	}

	postCast(elapsedMS: DOMHighResTimeStamp, isInitialCast: boolean) {
		state.units.forEach(unit => {
			if (unit === this) { return }
			unit.items.forEach((item, index) => {
				const effectFn = setData.itemEffects[item.id as ItemKey]?.castWithinHexRange
				if (effectFn) {
					const hexRange = item.effects['HexRange']
					if (hexRange == null) {
						return console.log('ERR', 'HexRange', item.name, item.effects)
					}
					if (this.hexDistanceTo(unit) <= hexRange) {
						effectFn(elapsedMS, item, uniqueIdentifier(index, item), this, unit)
					}
				}
			})
		})
		if (isInitialCast) {
			this.castCount += 1
			this.activeSynergies.forEach(({ key, activeEffect }) => setData.traitEffects[key]?.cast?.(activeEffect!, elapsedMS, this))
			getters.activeAugmentEffectsByTeam.value[this.team].forEach(([augment, effects]) => effects.cast?.(augment, elapsedMS, this))
			this.setBonusesFor(SpellKey.ManaReave)
			this.mana = this.getBonuses(BonusKey.ManaRestore) //TODO delay until mana lock
		}
	}

	jumpToBackline() {
		const [col, row] = this.startHex
		const targetHex: HexCoord = [col, this.team === 0 ? BOARD_ROW_COUNT - 1 : 0]
		const jumpHex = getClosestHexAvailableTo(targetHex, state.units)
		this.customMoveSpeed = 1500 // BACKLINE_JUMP_MS //TODO adjust speed for fixed duration
		this.moving = true
		this.setActiveHex(jumpHex ?? this.startHex)
		this.applyStatusEffect(0, StatusEffectType.stealth, BACKLINE_JUMP_MS)
	}

	canPerformAction(elapsedMS: DOMHighResTimeStamp) {
		return !this.moving && this.data.stats.range > 0 && !this.statusEffects.stunned.active && this.performActionUntilMS < elapsedMS
	}
	isAttackable() {
		return this.isInteractable() && !this.statusEffects.stealth.active && !this.statusEffects.banished.active
	}
	isInteractable() {
		return !this.dead && !this.statusEffects.banished.active
	}
	hasCollision() {
		return !this.dead || this.resurrecting
	}

	gainHealth(elapsedMS: DOMHighResTimeStamp, source: ChampionUnit | undefined, amount: number, isAffectedByGrievousWounds: boolean) {
		if (source) {
			getters.activeAugmentEffectsByTeam.value[this.team].forEach(([augment, effects]) => {
				if (effects.onHealShield) {
					effects.onHealShield(augment, elapsedMS, amount, this, source)
				}
			})
		}
		const healShieldBoost = source?.getBonuses(BonusKey.HealShieldBoost) ?? 0
		if (healShieldBoost !== 0) {
			amount *= (1 + healShieldBoost)
		}
		if (isAffectedByGrievousWounds) {
			const grievousWounds = this.getStatusEffect(elapsedMS, StatusEffectType.grievousWounds)
			if (grievousWounds != null && grievousWounds > 0) {
				amount *= grievousWounds
			}
		}
		const overheal = this.health - this.healthMax + amount
		this.health = Math.min(this.healthMax, this.health + amount)
		return overheal > 0 ? overheal : 0
	}

	setMana(amount: number) {
		this.mana = Math.min(this.manaMax(), amount)
	}
	addMana(amount: number) {
		this.setMana(this.mana + amount)
	}
	gainMana(elapsedMS: DOMHighResTimeStamp, amount: number) {
		if (elapsedMS < this.manaLockUntilMS) {
			return
		}
		this.addMana(amount)
	}

	die(elapsedMS: DOMHighResTimeStamp, source: ChampionUnit | undefined) {
		if (this.dead) {
			return console.warn('Already dead', this.name, this.instanceID)
		}
		this.health = 0
		this.dead = true

		this.bleeds.forEach(bleed => {
			if (bleed.remainingIterations > 0) {
				bleed.onDeath?.(elapsedMS, this)
			}
		})
		this.bleeds.clear()

		this.items.forEach((item, index) => setData.itemEffects[item.id as ItemKey]?.deathOfHolder?.(elapsedMS, item, uniqueIdentifier(index, item), this))

		const teamUnits = this.alliedUnits(false)
		if (teamUnits.length) {
			getters.synergiesByTeam.value.forEach((teamSynergies, teamNumber) => {
				teamSynergies.forEach(({ key, activeEffect }) => {
					if (!activeEffect) { return }
					const traitEffect = setData.traitEffects[key]
					if (!traitEffect) { return }
					const deathFn = teamNumber === this.team ? traitEffect.allyDeath : traitEffect.enemyDeath
					if (!deathFn) { return }
					const traitUnits = getAliveUnitsOfTeamWithTrait(teamNumber as TeamNumber, key)
					deathFn(activeEffect, elapsedMS, this, traitUnits)
				})
			})
			getters.activeAugmentEffectsByTeam.value[this.team].forEach(([augment, effects]) => {
				effects.allyDeath?.(augment, elapsedMS, this, source)
			})
			getters.activeAugmentEffectsByTeam.value[this.opposingTeam()].forEach(([augment, effects]) => {
				effects.enemyDeath?.(augment, elapsedMS, this, source)
			})
		} else {
			gameOver(this.team)
		}
	}

	canDamageCrit(sourceType: DamageSourceType, damageType: DamageType) {
		if (sourceType === DamageSourceType.spell) {
			if (damageType === DamageType.magic || damageType === DamageType.true) {
				return this.hasActive(TraitKey.Assassin) || this.hasItem(ItemKey.JeweledGauntlet) || getters.activeAugmentEffectsByTeam.value[this.team].some(([augment]) => augment.groupID === AugmentGroupKey.JeweledLotus)
			}
		} else if (sourceType === DamageSourceType.attack) {
			return damageType === DamageType.physical || damageType === DamageType.true
		}
		return false
	}

	damage(elapsedMS: DOMHighResTimeStamp, isOriginalSource: boolean, source: ChampionUnit | undefined, sourceType: DamageSourceType, damageCalculation: SpellCalculation, isAOE: boolean, damageModifier?: DamageModifier) {
		let [rawDamage, damageType] = solveSpellCalculationFrom(source, this, damageCalculation)
		source?.items.forEach((item, index) => {
			const modifyDamageFn = setData.itemEffects[item.id as ItemKey]?.modifyDamageByHolder
			if (modifyDamageFn) {
				rawDamage = modifyDamageFn(item, isOriginalSource, this, source, sourceType, rawDamage, damageType!)
			}
		})
		source?.activeSynergies.forEach(({ key, activeEffect }) => {
			const modifyDamageFn = setData.traitEffects[key]?.modifyDamageByHolder
			if (modifyDamageFn) {
				rawDamage = modifyDamageFn(activeEffect!, isOriginalSource, this, source, sourceType, rawDamage, damageType!)
			}
		})

		if (damageType === DamageType.heal) {
			this.gainHealth(elapsedMS, source, rawDamage, true)
			return
		}
		if (sourceType === DamageSourceType.attack) {
			const dodgeChance = this.dodgeChance() - source!.dodgePrevention()
			if (dodgeChance > 0) {
				rawDamage *= 1 - dodgeChance
			}
		}
		if (damageModifier?.increase != null) {
			rawDamage += damageModifier.increase
		}
		if (rawDamage <= 0) {
			return console.warn('Negative damage', rawDamage)
		}
		rawDamage *= 1 + (damageModifier?.multiplier ?? 0) + (source?.getBonuses(BonusKey.DamageIncrease) ?? 0)
		let defenseStat = damageType === DamageType.physical
			? this.armor()
			: damageType === DamageType.magic
				? this.magicResist()
				: null
		let reduction = 0
		if (damageType === DamageType.physical) {
			reduction += (this.getStatusEffect(elapsedMS, StatusEffectType.armorReduction) ?? 0) + this.getBonuses(BonusKey.ArmorShred)
		} else if (damageType === DamageType.magic) {
			reduction += (this.getStatusEffect(elapsedMS, StatusEffectType.magicResistReduction) ?? 0) + this.getBonuses(BonusKey.MagicResistShred)
		}
		if (reduction > 0) {
			defenseStat! *= (1 - reduction)
		}
		if (source && (damageType === DamageType.physical || (damageType === DamageType.magic && source.canDamageCrit(sourceType, damageType)))) {
			const critReduction = this.critReduction()
			if (critReduction < 1) {
				const critDamage = rawDamage * source.critChance(damageModifier) * source.critMultiplier(damageModifier)
				rawDamage += critDamage * (1 - critReduction)
			}
		}
		const defenseMultiplier = defenseStat != null ? 100 / (100 + defenseStat) : 1
		let takingDamage = rawDamage * defenseMultiplier
		if (damageType !== DamageType.true) {
			const damageReduction = this.getBonuses(BonusKey.DamageReduction)
			if (damageReduction > 0) {
				if (damageReduction >= 1) {
					console.log('ERR', 'damageReduction must be between 0–1.')
				} else {
					takingDamage *= 1 - damageReduction
				}
			}
			if (isAOE) {
				const aoeDamageReduction = this.getStatusEffect(elapsedMS, StatusEffectType.aoeDamageReduction)
				if (aoeDamageReduction != null) {
					takingDamage *= 1 - aoeDamageReduction / 100
				}
			}
		}
		if (this.statusEffects.invulnerable.active) {
			takingDamage = 0
		}
		let healthDamage = takingDamage
		this.shields
			.filter(shield => shield.activated === true && shield.isSpellShield !== true)
			.forEach(shield => {
				const protectingDamage = Math.min(shield.amount, healthDamage)
				if (protectingDamage >= shield.amount) {
					shield.amount = 0
					shield.onRemoved?.(elapsedMS, shield)
					shield.activated = false
				} else {
					shield.amount -= protectingDamage
				}
				healthDamage -= protectingDamage
			})

		// Update health

		const originalHealth = this.health
		this.health -= healthDamage
		const manaGain = Math.min(42.5, rawDamage * 0.01 + takingDamage * 0.07) //TODO verify https://leagueoflegends.fandom.com/wiki/Mana_(Teamfight_Tactics)#Mechanic
		this.gainMana(elapsedMS, manaGain)

		// `source` effects

		if (source && damageType) {
			const sourceVamp = source.getVamp(damageType, sourceType)
			if (sourceVamp > 0) {
				source.gainHealth(elapsedMS, source, takingDamage * sourceVamp / 100, true)
			}

			if (isOriginalSource) {
				source.items.forEach((item, index) => setData.itemEffects[item.id as ItemKey]?.damageDealtByHolder?.(item, uniqueIdentifier(index, item), elapsedMS, isOriginalSource, this, source, sourceType, rawDamage, takingDamage, damageType!))
				source.activeSynergies.forEach(({ key, activeEffect }) => setData.traitEffects[key]?.damageDealtByHolder?.(activeEffect!, elapsedMS, isOriginalSource, this, source, sourceType, rawDamage, takingDamage, damageType!))
				getters.activeAugmentEffectsByTeam.value[source.team].forEach(([augment, effects]) => {
					effects.damageDealtByHolder?.(augment, elapsedMS, isOriginalSource, this, source, sourceType, rawDamage, takingDamage, damageType!)
				})
				if (sourceType === DamageSourceType.attack) {
					source.shields.forEach(shield => {
						if (shield.activated === true && shield.bonusDamage) {
							this.damage(elapsedMS, false, source, DamageSourceType.bonus, shield.bonusDamage, false)
						}
					})
				}
			}
		}

		// `this` effects

		this.items.forEach((item, index) => {
			const uniqueID = uniqueIdentifier(index, item)
			const effects = setData.itemEffects[item.id as ItemKey]
			if (effects) {
				effects.damageTaken?.(elapsedMS, item, uniqueID, isOriginalSource, this, source, sourceType, rawDamage, takingDamage, damageType!)
				const hpThresholdFn = effects.hpThreshold
				if (hpThresholdFn && this.checkHPThreshold(uniqueID, item.effects, originalHealth, healthDamage)) {
					hpThresholdFn(elapsedMS, item, uniqueID, this)
				}
			}
		})
		this.activeSynergies.forEach(({ key, activeEffect }) => {
			const effects = setData.traitEffects[key]
			if (effects) {
				const hpThresholdFn = effects.hpThreshold
				if (hpThresholdFn && this.checkHPThreshold(key, activeEffect!.variables, originalHealth, healthDamage)) {
					hpThresholdFn(activeEffect!, elapsedMS, this)
				}
			}
		})
		getters.activeAugmentEffectsByTeam.value[this.team].forEach(([augment, effects]) => {
			const hpThresholdFn = effects.hpThreshold
			if (hpThresholdFn && this.checkHPThreshold(augment.name, augment.effects, originalHealth, healthDamage)) {
				hpThresholdFn(augment, elapsedMS, this)
			}
		})

		// Die

		if (this.health <= 0) {
			this.die(elapsedMS, source)
		}
		return healthDamage
	}

	checkHPThreshold(uniqueID: string, effects: EffectVariables, originalHealth: number, healthDamage: number) {
		uniqueID += this.instanceID
		const hpThreshold = effects['HPThreshold'] ?? effects['HealthThreshold'] ?? effects['HealthThreshold1'] //TODO normalize Health
		if (hpThreshold != null) {
			const previousActivationThreshold = thresholdCheck[uniqueID]
			if (hpThreshold !== previousActivationThreshold && this.healthProportion() <= hpThreshold / 100) {
				thresholdCheck[uniqueID] = hpThreshold
				const damageReduction = effects[BonusKey.DamageReduction] ?? (effects['InvulnDuration'] != null ? 100 : undefined)
				if (damageReduction != null) {
					const thresholdHealth = this.healthMax * hpThreshold / 100
					const damageAfterThreshold = healthDamage - (originalHealth - thresholdHealth)
					this.health = thresholdHealth - damageAfterThreshold * (1 - damageReduction / 100)
				}
				return true
			}
		} else {
			console.log('ERR', 'HPThreshold', uniqueID, effects)
		}
		return false
	}

	clearNegativeEffects() {
		NEGATIVE_STATUS_EFFECTS.forEach(statusEffect => this.statusEffects[statusEffect].active = false)
	}

	consumeSpellShield() {
		const availableSpellShields = this.shields
			.filter(shield => shield.activated === true && shield.isSpellShield === true)
			.sort((a, b) => a.amount - b.amount)
		const shield = availableSpellShields.length ? availableSpellShields[0] : undefined
		if (shield != null && shield.amount > 0) {
			shield.activated = false
		}
		return shield
	}

	alliedUnits(includingSelf: boolean): ChampionUnit[] {
		return state.units.filter(unit => (includingSelf ? true : unit !== this) && !unit.dead && unit.team === this.team)
	}

	coordDistanceSquaredToHex(hex: HexCoord) {
		return coordinateDistanceSquared(this.coord, getCoordFrom(hex))
	}
	hexDistanceTo(unit: ChampionUnit) {
		return this.hexDistanceToHex(unit.activeHex)
	}
	hexDistanceToHex(hex: HexCoord) {
		return hexDistanceFrom(this.activeHex, hex)
	}

	isAt(hex: HexCoord) {
		return isSameHex(this.activeHex, hex)
	}
	isStartAt(hex: HexCoord) {
		return isSameHex(this.startHex, hex)
	}
	isIn(hexes: Iterable<HexCoord>) {
		return containsHex(this.activeHex, hexes)
	}

	setActiveHex(hex: HexCoord) {
		this.movesBeforeDroppingTarget -= 1
		this.activeHex[0] = hex[0]
		this.activeHex[1] = hex[1]
	}
	reposition(hex: HexCoord) {
		if (state.isRunning) {
			return
		}
		this.startHex = hex
		this.team = hex[1] < BOARD_ROW_PER_SIDE_COUNT ? 0 : 1
		window.setTimeout(() => saveUnits(state.setNumber))
	}
	getCoord() {
		return getCoordFrom(this.activeHex)
	}

	getStat(key: BonusKey) {
		if (key === BonusKey.Armor) {
			return this.armor()
		}
		if (key === BonusKey.AttackDamage) {
			return this.attackDamage()
		}
		if (key === BonusKey.AbilityPower) {
			return this.abilityPower()
		}
		if (key === BonusKey.Health) {
			return this.healthMax
		}
		if (key === BonusKey.CurrentHealth) {
			return this.health
		}
		if (key === BonusKey.MissingHealth) {
			return this.missingHealth()
		}
		console.log('ERR', 'Missing stat', key)
		return 0
	}

	getCurrentSpell(): ChampionSpellData | undefined {
		return this.data.spells[this.transformIndex]
	}
	getSpellFor(spellSuffix: string): ChampionSpellData | undefined {
		const spellName = this.data.apiName + spellSuffix
		return this.data.spells.find(spell => spell.name === spellName)
	}

	getSpellVariableIfExists(spell: ChampionSpellData | undefined, key: SpellKey) {
		return spell?.variables[key]?.[this.starLevel]
	}
	getSpellVariable(spell: ChampionSpellData | undefined, key: SpellKey) {
		const value = this.getSpellVariableIfExists(spell, key)
		if (value == null) {
			console.log('ERR', this.name, spell?.name, key)
			return 0
		}
		return value
	}
	getSpellCalculationResult(spell: ChampionSpellData | undefined, key: SpellKey) {
		const calculation = this.getSpellCalculation(spell, key)
		return calculation ? solveSpellCalculationFrom(this, undefined, calculation)[0] : 0
	}
	getSpellCalculation(spell: ChampionSpellData | undefined, key: SpellKey, silent: boolean = false) {
		if (!spell) {
			console.log('ERR', 'No spell', this.name, key)
			return undefined
		}
		const calculation = spell.calculations[key]
		if (calculation == null) {
			if (!silent) {
				console.log('ERR', 'Missing calculation for', spell.name, key)
			}
			return undefined
		}
		return calculation
	}

	setBonusesFor(sourceKey: BonusLabelKey, ...bonuses: BonusVariable[]) {
		const existingBonuses = this.getBonusesFrom(sourceKey)
		const bonus = existingBonuses[0] ?? [sourceKey, []]
		if (existingBonuses[0] == null) {
			this.bonuses.push(bonus)
		}
		bonus[1] = bonuses
	}

	getBonusesFrom(sourceKey: BonusLabelKey) {
		return this.bonuses
			.filter(bonus => bonus[0] === sourceKey)
	}
	getBonusesFromKey(sourceKey: BonusLabelKey, bonusKey: BonusKey) {
		return this.getBonusesFrom(sourceKey)
			.flatMap(bonus => bonus[1])
			.filter(bonus => bonus[0] === bonusKey)
			.reduce((acc, bonus) => acc + (bonus[1] ?? 0), 0)
	}
	getBonusVariants(bonus: BonusKey) {
		return this.getBonuses(bonus, `Bonus${bonus}` as BonusKey, `${this.starLevel}Star${bonus}` as BonusKey)
	}
	getBonuses(...variableNames: BonusKey[]) {
		return this.bonuses
			.reduce((accumulator, bonus: BonusEntry) => {
				const variables = bonus[1].filter(variable => variableNames.includes(variable[0] as BonusKey))
				return accumulator + variables.reduce((total, v) => total + (v[1] ?? 0), 0)
			}, 0)
	}

	hasActive(name: BonusLabelKey) {
		return !!this.bonuses.find(bonus => bonus[0] === name)
	}
	hasItem(key: ItemKey) {
		return !!this.items.find(item => item.id === key)
	}
	hasTrait(key: TraitKey) {
		return !!this.traits.find(trait => trait.name === key) || getters.activeAugmentEffectsByTeam.value[this.team].some(([_, effects]) => effects.teamWideTrait === key)
	}
	jumpsToBackline() {
		return this.hasTrait(TraitKey.Assassin)
	}

	attackDamage() {
		let baseAD = this.data.stats.damage
		if (baseAD === 0) {
			baseAD = [100, 100, 125, 140][stageIndex()]
		}
		const ad = baseAD * this.starMultiplier + this.getBonusVariants(BonusKey.AttackDamage)
		const multiplyAttackSpeed = this.getSpellVariableIfExists(this.getCurrentSpell(), SpellKey.ADFromAttackSpeed)
		if (multiplyAttackSpeed != null) {
			return ad + this.bonusAttackSpeed() * 100 * multiplyAttackSpeed
		}
		return ad
	}
	abilityPower() {
		return 100 + this.getBonusVariants(BonusKey.AbilityPower)
	}
	manaMax() {
		const maxManaMultiplier = this.getBonuses(BonusKey.ManaReductionPercent)
		const multiplier = maxManaMultiplier === 0 ? 1 : (1 - maxManaMultiplier / 100)
		const maxManaReduction = this.getBonuses(BonusKey.ManaReduction)
		return (this.data.stats.mana - maxManaReduction) * multiplier
	}
	armor() {
		return this.data.stats.armor + this.getBonusVariants(BonusKey.Armor)
	}
	magicResist() {
		return this.data.stats.magicResist + this.getBonusVariants(BonusKey.MagicResist)
	}
	bonusAttackSpeed() {
		return this.getBonusVariants(BonusKey.AttackSpeed) / 100
	}
	attackSpeed() {
		return Math.min(5, this.fixedAS ?? this.data.stats.attackSpeed + this.bonusAttackSpeed())
	}
	range() {
		return this.data.stats.range + this.getBonuses(BonusKey.HexRangeIncrease)
	}
	moveSpeed() {
		return this.customMoveSpeed ?? (this.data.stats.moveSpeed + this.getBonuses(BonusKey.MoveSpeed))
	}

	missingHealth() {
		return this.healthMax - this.health
	}
	healthProportion() {
		return this.health / this.healthMax
	}

	dodgeChance() {
		return this.getBonuses(BonusKey.DodgeChance) / 100
	}
	dodgePrevention() {
		return this.getBonuses(BonusKey.AttackAccuracy) / 100
	}

	getVamp(damageType: DamageType, damageSource: DamageSourceType) {
		const vampBonuses = [BonusKey.VampOmni]
		if (damageSource !== DamageSourceType.bonus) {
			if (damageType === DamageType.physical) {
				vampBonuses.push(BonusKey.VampPhysical)
			}
			if (damageType === DamageType.magic || damageType === DamageType.true) {
				vampBonuses.push(BonusKey.VampSpell)
			}
		}
		return this.getBonuses(...vampBonuses)
	}

	getInteractableUnitsIn(hexes: HexCoord[], team: TeamNumber | null): ChampionUnit[] {
		return state.units.filter(unit => {
			if ((team != null && unit.team !== team) || !unit.isInteractable()) {
				return false
			}
			return unit.isIn(hexes)
		})
	}
	getInteractableUnitsWithin(distance: number, team: TeamNumber | null): ChampionUnit[] {
		const hexes = getSurroundingWithin(this.activeHex, distance, true)
		return this.getInteractableUnitsIn(hexes, team)
	}

	getAttackModifier(elapsedMS: DOMHighResTimeStamp) {
		return getters.activeAugmentEffectsByTeam.value[this.team].reduce((modifier, [augment, effects]) => {
			return effects.modifyAttacks ? Object.assign(modifier, effects.modifyAttacks(augment, elapsedMS, this)) : modifier
		}, {} as AttackEffectData)
	}

	queueBonus(elapsedMS: DOMHighResTimeStamp, startsAfterMS: DOMHighResTimeStamp, bonusLabel: BonusLabelKey, ...variables: BonusVariable[]) {
		this.pendingBonuses.add([elapsedMS + startsAfterMS, bonusLabel, variables])
	}
	queueShield(elapsedMS: DOMHighResTimeStamp, source: ChampionUnit | undefined, data: ShieldData) {
		if (source) {
			getters.activeAugmentEffectsByTeam.value[this.team].forEach(([augment, effects]) => {
				if (effects.onHealShield) {
					effects.onHealShield(augment, elapsedMS, data.amount, this, source)
				}
			})
		}
		const delaysActivation = data.activatesAfterMS != null
		this.shields.push({
			id: data.id,
			source: source,
			activated: !delaysActivation,
			activatesAtMS: delaysActivation ? elapsedMS + data.activatesAfterMS! : undefined,
			isSpellShield: data.isSpellShield,
			amount: data.amount,
			repeatAmount: data.repeatAmount,
			expiresAtMS: data.expiresAfterMS != null ? elapsedMS + data.expiresAfterMS : undefined,
			repeatsEveryMS: data.repeatsEveryMS,
			bonusDamage: data.bonusDamage,
			onRemoved: data.onRemoved,
		})
	}

	queueProjectileEffect(elapsedMS: DOMHighResTimeStamp, spell: ChampionSpellData | undefined, data: ProjectileEffectData) {
		if (spell || data.damageSourceType === DamageSourceType.spell || data.damageSourceType === DamageSourceType.attack) {
			Object.assign(data, this.getAttackModifier(elapsedMS))
		}
		if (spell) {
			if (!data.damageCalculation && data.targetTeam !== this.team) {
				const damageCalculation = this.getSpellCalculation(spell, SpellKey.Damage, true)
				if (data.hexEffect) {
					data.hexEffect.damageCalculation = damageCalculation
				} else {
					data.damageCalculation = damageCalculation
				}
			}
			if (!data.damageSourceType) {
				data.damageSourceType = DamageSourceType.spell
			}
			if (!data.missile) {
				data.missile = spell.missile
			}
		}
		if (data.target == null) {
			const target = this.target
			if (!target) {
				console.error('ERR', 'No target for projectile', this.name, spell?.name)
				return undefined
			}
			data.target = data.fixedHexRange != null || data.missile?.tracksTarget === false ? target.activeHex : target
		}
		if (data.hexEffect) {
			if (data.hexEffect.hexDistanceFromSource != null && !data.hexEffect.hexSource) {
				data.hexEffect.hexSource = data.target
			}
		}
		const projectile = new ProjectileEffect(this, elapsedMS, spell, data)
		state.projectileEffects.add(projectile)
		if (elapsedMS > 0) {
			if (spell) {
				this.manaLockUntilMS = projectile.startsAtMS + DEFAULT_MANA_LOCK_MS
				this.performActionUntilMS = projectile.activatesAtMS
			} else {
				this.attackStartAtMS = projectile.startsAtMS
				this.performActionUntilMS = projectile.startsAtMS
			}
		}
		if (spell && data.hasBackingVisual === true) {
			const angle = this.angleTo(data.target) + (data.changeRadians ?? 0)
			this.queueShapeEffect(elapsedMS, undefined, {
				shape: new ShapeEffectVisualRectangle(this, angle, [spell.missile!.width! * 2 * HEX_PROPORTION_PER_LEAGUEUNIT, HEX_PROPORTION * MAX_HEX_COUNT]),
				expiresAfterMS: 1000,
				opacity: 0.5,
			})
		}
		return projectile
	}
	queueHexEffect(elapsedMS: DOMHighResTimeStamp, spell: ChampionSpellData | undefined, data: HexEffectData) {
		if (spell && !data.damageCalculation && data.targetTeam !== this.team) {
			data.damageCalculation = this.getSpellCalculation(spell, SpellKey.Damage, true)
		}
		if (data.damageCalculation && !data.damageSourceType) {
			data.damageSourceType = DamageSourceType.spell
		}
		if (data.damageCalculation && !data.targetTeam) {
			data.targetTeam = this.opposingTeam()
		}
		const hexEffect = new HexEffect(this, elapsedMS, spell, data)
		state.hexEffects.add(hexEffect)
		if (elapsedMS > 0 && spell) {
			this.attackStartAtMS = hexEffect.activatesAtMS
			this.manaLockUntilMS = hexEffect.activatesAtMS + DEFAULT_MANA_LOCK_MS
			this.performActionUntilMS = hexEffect.activatesAtMS
		}
		return hexEffect
	}

	queueShapeEffect(elapsedMS: DOMHighResTimeStamp, spell: ChampionSpellData | undefined, data: ShapeEffectData) {
		if (spell && !data.damageCalculation && data.targetTeam !== this.team) {
			data.damageCalculation = this.getSpellCalculation(spell, SpellKey.Damage, true)
		}
		if (data.damageCalculation && !data.damageSourceType) {
			data.damageSourceType = DamageSourceType.spell
		}
		const shapeEffect = new ShapeEffect(this, elapsedMS, spell, data)
		state.shapeEffects.add(shapeEffect)
		if (spell) {
			this.attackStartAtMS = shapeEffect.activatesAtMS
			this.manaLockUntilMS = shapeEffect.activatesAtMS + DEFAULT_MANA_LOCK_MS
			this.performActionUntilMS = shapeEffect.activatesAtMS
		}
		return shapeEffect
	}
	queueTargetEffect(elapsedMS: DOMHighResTimeStamp, spell: ChampionSpellData | undefined, data: TargetEffectData) {
		if (spell || data.damageSourceType === DamageSourceType.spell || data.damageSourceType === DamageSourceType.attack) {
			Object.assign(data, this.getAttackModifier(elapsedMS))
		}
		if (spell && !data.damageCalculation && data.targetTeam !== this.team) {
			data.damageCalculation = this.getSpellCalculation(spell, SpellKey.Damage, true)
		}
		if (data.damageCalculation && data.damageSourceType == null) {
			data.damageSourceType = DamageSourceType.spell
		}
		if (!data.sourceTargets) {
			if (!this.target) {
				console.log('ERR', 'No target', this.name, spell?.name)
				return undefined
			}
			data.sourceTargets = [[this, this.target]]
		}
		const targetEffect = new TargetEffect(this, elapsedMS, spell, data)
		state.targetEffects.add(targetEffect)
		if (spell) {
			this.attackStartAtMS = targetEffect.activatesAtMS
			this.manaLockUntilMS = targetEffect.activatesAtMS + DEFAULT_MANA_LOCK_MS
			this.performActionUntilMS = targetEffect.activatesAtMS
		}
		return targetEffect
	}

	angleTo(target: ChampionUnit | HexCoord) {
		const coord = 'coord' in target ? target.coord : getCoordFrom(target)
		return getAngleBetween(this.coord, coord)
	}

	projectHexFromHex(targetHex: HexCoord, pastTarget: boolean) {
		const bestHex = getBestAsMax(pastTarget, getHexRing(targetHex, 1), (hex) => this.coordDistanceSquaredToHex(hex))
		return getClosestHexAvailableTo(bestHex ?? targetHex, state.units)
	}
	projectHexFrom(target: ChampionUnit, pastTarget: boolean) {
		return this.projectHexFromHex(target.activeHex, pastTarget)
	}
}
