import { markRaw } from 'vue'

import abilities from '#/data/set6/abilities'
import type { AbilityFn } from '#/data/set6/abilities'
import { champions } from '#/data/set6/champions'
import type { ItemKey } from '#/data/set6/items'
import { TraitKey, traits } from '#/data/set6/traits'

import { getNextHex, updatePaths } from '#/game/pathfind'

import { containsHex, getClosestHexAvailableTo, getNearestEnemies, hexDistanceFrom, isSameHex } from '#/helpers/boardUtils'
import { BACKLINE_JUMP_MS, BOARD_ROW_COUNT, BOARD_ROW_PER_SIDE_COUNT, HEX_MOVE_UNITS } from '#/helpers/constants'
import { BonusKey } from '#/helpers/types'
import type { HexCoord, StarLevel, TeamNumber, ChampionData, ItemData, TraitData, SynergyData } from '#/helpers/types'
import { saveUnits } from '#/helpers/storage'
import { DamageType } from '#/helpers/types'

type BonusVariable = [key: string, value: number | null]

export class ChampionUnit {
	name: string
	startPosition: HexCoord = [0, 0]
	team: TeamNumber = 0
	starLevel: StarLevel
	data: ChampionData

	activePosition: HexCoord | undefined
	dead = false
	target: ChampionUnit | null = null // eslint-disable-line no-use-before-define
	mana = 0
	health = 0
	healthMax = 0
	attackSpeedMultiplier = 1
	starMultiplier = 1

	ghosting = false
	cachedTargetDistance = 0
	attackStartAtMS: DOMHighResTimeStamp = 0
	moveUntilMS: DOMHighResTimeStamp = 0
	manaLockUntilMS: DOMHighResTimeStamp = 0
	stunnedUntilMS: DOMHighResTimeStamp = 0
	items: ItemData[] = []
	traits: TraitData[] = []
	bonuses: [TraitKey | ItemKey, BonusVariable[]][] = []
	ability: AbilityFn | undefined

	constructor(name: string, position: HexCoord, starLevel: StarLevel, synergiesByTeam: SynergyData[][]) {
		const stats = champions.find(unit => unit.name === name)
		if (!stats) {
			console.log('ERR Invalid unit', name)
		}
		this.data = markRaw(stats ?? champions[0])
		this.name = name
		this.starLevel = starLevel
		this.ability = abilities[name]
		this.reset(synergiesByTeam)
		this.reposition(position)
	}

	reset(synergiesByTeam: SynergyData[][]) {
		this.starMultiplier = this.starLevel === 1 ? 1 : (this.starLevel - 1) * 1.8
		this.dead = false
		this.target = null
		this.activePosition = undefined
		this.mana = this.data.stats.initialMana
		this.health = this.data.stats.hp * this.starMultiplier
		this.healthMax = this.health
		this.attackSpeedMultiplier = 1
		this.cachedTargetDistance = 0
		this.attackStartAtMS = 0
		this.moveUntilMS = 0
		this.manaLockUntilMS = 0
		this.stunnedUntilMS = 0
		this.ghosting = this.jumpsToBackline()
		const traitNames = this.data.traits.concat(this.items.filter(item => item.name.endsWith(' Emblem')).map(item => item.name.replace(' Emblem', '')))
		this.traits = Array.from(new Set(traitNames)).map(traitName => traits.find(trait => trait.name === traitName)).filter((trait): trait is TraitData => !!trait)
		this.bonuses = []
		const teamSynergies = synergiesByTeam[this.team]
		teamSynergies.forEach(([trait, style, effect]) => {
			if (effect != null && traitNames.includes(trait.name)) {
				const variables: BonusVariable[] = []
				for (const key in effect.variables) {
					variables.push([key, effect.variables[key]])
				}
				this.bonuses.push([trait.name as TraitKey, variables])
			}
		})

		// Innate bonuses (not handled in data)
		console.log(this.name, traitNames.includes(TraitKey.Sniper), teamSynergies.find(synergy => synergy[0].name === TraitKey.Sniper))
		if (traitNames.includes(TraitKey.Sniper)) {
			const synergy = teamSynergies.find(synergy => synergy[0].name === TraitKey.Sniper)
			if (!synergy?.[2]) {
				const value = synergy?.[0].effects[0].variables[BonusKey.HexRangeIncrease] ?? 1
				this.bonuses.push([TraitKey.Sniper, [[BonusKey.HexRangeIncrease, value]]])
			}
		}
		//TODO collosus

		this.items.forEach(item => {
			const variables: BonusVariable[] = []
			for (const key in item.effects) {
				variables.push([key, item.effects[key]])
			}
			this.bonuses.push([item.id as ItemKey, variables])
		})
		console.log(this.name, this.bonuses)
	}

	updateTarget(units: ChampionUnit[]) {
		if (this.target != null) {
			const targetDistance = this.hexDistanceTo(this.target)
			if (!this.target.attackable() || targetDistance > this.range()) {
				this.target = null
			} else {
				this.cachedTargetDistance = targetDistance
			}
		}
		if (this.target == null) {
			const targets = getNearestEnemies(this, units)
			if (targets.length) {
				this.target = targets[0] //TODO choose random
				this.cachedTargetDistance = this.hexDistanceTo(this.target)
				// console.log(this.name, this.team, 'targets at', this.cachedTargetDistance, 'hexes', this.target.name, this.target.team)
			}
		}
	}

	updateAttack(elapsedMS: DOMHighResTimeStamp, units: ChampionUnit[], gameOver: (team: TeamNumber) => void) {
		if (this.target != null) {
			const msBetweenAttacks = 1000 / this.attackSpeed()
			if (elapsedMS >= this.attackStartAtMS + msBetweenAttacks) {
				if (this.attackStartAtMS > 0) {
					this.target.damage(elapsedMS, this.attackDamage(), DamageType.physical, this, units, gameOver) //TODO projectile
					this.gainMana(elapsedMS, 10)
				}
				this.attackStartAtMS = elapsedMS
			}
		}
	}

	updateMove(elapsedMS: DOMHighResTimeStamp, units: ChampionUnit[]) {
		const nextHex = getNextHex(this)
		if (nextHex) {
			const msPerHex = 1000 * HEX_MOVE_UNITS / this.moveSpeed()
			this.moveUntilMS = elapsedMS + msPerHex
			this.activePosition = nextHex
			updatePaths(units)
			return true
		}
		return false
	}

	readyToCast() {
		return !!this.ability && this.mana >= this.manaMax()
	}
	castAbility(elapsedMS: DOMHighResTimeStamp) {
		this.ability?.(elapsedMS, this)
		this.mana = 0
	}

	jumpToBackline(elapsedMS: DOMHighResTimeStamp, units: ChampionUnit[]) {
		const [col, row] = this.currentPosition()
		const targetHex: HexCoord = [col, this.team === 0 ? BOARD_ROW_COUNT - 1 : 0]
		this.activePosition = getClosestHexAvailableTo(targetHex, units) ?? this.currentPosition()
		this.moveUntilMS = elapsedMS + BACKLINE_JUMP_MS
		this.ghosting = false
	}

	attackable() {
		return !this.dead && !this.ghosting
	}
	collides() {
		return !this.dead && !this.ghosting
	}

	isMoving(elapsedMS: DOMHighResTimeStamp) {
		return elapsedMS < this.moveUntilMS
	}

	gainMana(elapsedMS: DOMHighResTimeStamp, amount: number) {
		if (elapsedMS < this.manaLockUntilMS) {
			return
		}
		this.mana = Math.min(this.manaMax(), this.mana + amount)
	}

	damage(elapsedMS: DOMHighResTimeStamp, rawDamage: number, type: DamageType, fromUnit: ChampionUnit, units: ChampionUnit[], gameOver: (team: TeamNumber) => void) {
		const defenseStat = type === DamageType.physical
			? this.armor()
			: type === DamageType.magic
				? this.magicResist()
				: null
		if (type === DamageType.magic) {
			rawDamage *= fromUnit.abilityPowerMultiplier()
		}
		const defenseMultiplier = defenseStat != null ? 100 / (100 + defenseStat) : 1
		const takenDamage = rawDamage * defenseMultiplier
		if (this.health < takenDamage) {
			this.health = 0
			this.dead = true
			if (units.find(unit => unit.team === this.team && !unit.dead)) {
				updatePaths(units)
			} else {
				gameOver(this.team)
			}
		} else {
			this.health -= takenDamage
			const manaGain = Math.min(42.5, rawDamage * 0.01 + takenDamage * 0.07) //TODO verify https://leagueoflegends.fandom.com/wiki/Mana_(Teamfight_Tactics)#Mechanic
			this.gainMana(elapsedMS, manaGain)
		}
	}

	hexDistanceTo(unit: ChampionUnit) {
		return hexDistanceFrom(this.currentPosition(), unit.currentPosition())
	}

	isAt(position: HexCoord) {
		return isSameHex(this.currentPosition(), position)
	}
	isStartAt(position: HexCoord) {
		return isSameHex(this.startPosition, position)
	}
	isIn(hexes: Iterable<HexCoord>) {
		return containsHex(this.currentPosition(), hexes)
	}

	reposition(position: HexCoord) {
		this.startPosition = position
		this.team = position[1] < BOARD_ROW_PER_SIDE_COUNT ? 0 : 1
		window.setTimeout(saveUnits)
	}
	currentPosition() {
		return this.activePosition ?? this.startPosition
	}

	getBonusFor(sourceKey: TraitKey | ItemKey) {
		return this.bonuses.filter(bonus => bonus[0] === sourceKey)
	}
	getBonuses(variableName: string) {
		return this.bonuses
			.reduce((accumulator, bonus: [TraitKey | ItemKey, BonusVariable[]]) => {
				const value = bonus[1].find(variable => variable[0] === variableName)?.[1]
				return accumulator + (value ?? 0)
			}, 0)
	}
	hasTrait(name: TraitKey) {
		return !!this.traits.find(trait => trait.name === name)
	}
	jumpsToBackline() {
		return this.hasTrait(TraitKey.Assassin)
	}

	attackDamage() {
		return this.data.stats.damage * this.starMultiplier //TODO items
	}
	abilityPowerMultiplier() {
		return 1 //TODO items, traits
	}
	manaMax() {
		return this.data.stats.mana //TODO yordle mutant
	}
	armor() {
		return this.data.stats.armor //TODO items
	}
	magicResist() {
		return this.data.stats.magicResist //TODO items
	}
	attackSpeed() {
		return this.data.stats.attackSpeed * this.attackSpeedMultiplier //TODO items
	}
	range() {
		return this.data.stats.range + this.getBonuses('HexRangeIncrease')
	}
	moveSpeed() {
		return 550 //TODO featherweights
	}
}
