import { BonusKey } from '@tacticians-academy/academy-library'
import type { ChampionSpellData } from '@tacticians-academy/academy-library'
import { ChampionKey } from '@tacticians-academy/academy-library/dist/set6.5/champions'

import { state } from '#/store/store'

import type { ChampionUnit } from '#/sim/ChampionUnit'
import { delayUntil } from '#/sim/loop'

import { isVIPActiveFor } from '#/sim/data/set6/utils'
import type { ChampionEffects } from '#/sim/data/types'
import { ShapeEffectCircle, ShapeEffectCone } from '#/sim/effects/ShapeEffect'

import { toRadians } from '#/sim/helpers/angles'
import { getDistanceUnitOfTeamWithinRangeTo, getBestHexWithinRangeTo, getBestDensityHexes, getProjectedHexLineFrom, getHexRing, getHexesSurroundingWithin } from '#/sim/helpers/board'
import type { SurroundingHexRange } from '#/sim/helpers/board'
import { DEFAULT_CAST_SECONDS, HEX_MOVE_LEAGUEUNITS, MAX_HEX_COUNT } from '#/sim/helpers/constants'
import { getAttackableUnitsOfTeam, getDistanceHex, getDistanceUnitOfTeam, getInteractableUnitsOfTeam, getProjectileSpread } from '#/sim/helpers/effectUtils'
import { DamageSourceType, SpellKey, StatusEffectType } from '#/sim/helpers/types'
import type { BonusLabelKey, DamageModifier, HexCoord, ShieldData } from '#/sim/helpers/types'
import { getBestArrayAsMax, getBestRandomAsMax, getBestSortedAsMax, randomItem } from '#/sim/helpers/utils'

import { baseChampionEffects } from '../champions'

export const championEffects = {

	...baseChampionEffects,

	[ChampionKey.Ahri]: {
		cast: (elapsedMS, spell, champion) => {
			if (!champion.wasInRangeOfTarget) { return false }
			const missile = champion.getMissileWithSuffix('OrbMissile')
			const degreesBetweenOrbs = champion.getSpellVariable(spell, 'AngleBetweenOrbs')
			const radiansBetweenOrbs = toRadians(degreesBetweenOrbs)
			const multiOrbProportion = champion.getSpellVariable(spell, 'MultiOrbDamage')
			const orbsPerCast = champion.getSpellVariable(spell, 'SpiritFireStacks')
			const maxRange = champion.getSpellVariable(spell, 'HexRange')
			const orbCount = champion.castCount * orbsPerCast + 1
			getProjectileSpread(orbCount, radiansBetweenOrbs).forEach(changeRadians => {
				champion.queueProjectileEffect(elapsedMS, spell, {
					fixedHexRange: maxRange,
					destroysOnCollision: false,
					modifiesOnMultiHit: true,
					damageModifier: {
						multiplier: multiOrbProportion - 1,
					},
					changeRadians,
					missile,
					returnMissile: champion.getMissileWithSuffix('OrbReturn') ?? missile,
					targetDeathAction: 'continue',
				})
			})
			return true
		},
	},

	[ChampionKey.Alistar]: {
		cast: (elapsedMS, spell, champion) => {
			const target = champion.target
			if (!target) { return false }
			const checkingUnits = state.units.filter(unit => unit !== champion && unit !== target)
			let targetHex: HexCoord | undefined
			const moveSpeed = 1000 //TODO experimentally determine
			const knockupSeconds = champion.getSpellVariable(spell, 'KnockupDuration')
			champion.queueMoveUnitEffect(elapsedMS, spell, {
				target: champion,
				targetTeam: target.team,
				ignoresDestinationCollision: true,
				idealDestination: () => {
					const hexLineThroughTarget = getProjectedHexLineFrom(champion, target)
					const availableInLine = hexLineThroughTarget.filter(hex => !checkingUnits.some(unit => unit.isAt(hex)))
					const championHex = availableInLine.pop()
					targetHex = availableInLine.pop()
					return championHex ?? target.activeHex
				},
				moveSpeed,
				onCollided: (elapsedMS, effect, withUnit) => {
					if (withUnit === target) {
						if (targetHex) {
							target.customMoveTo(targetHex ?? target, true, moveSpeed, undefined, false, (elapsedMS, target) => {
								const stunSeconds = champion.getSpellVariable(spell, SpellKey.StunDuration)
								target.applyStatusEffect(elapsedMS, StatusEffectType.stunned, stunSeconds * 1000)
							})
						}
					}
				},
				hexEffect: {
					hexDistanceFromSource: 2,
					statusEffects: [
						[StatusEffectType.stunned, { durationMS: knockupSeconds * 1000 }],
					],
				},
			})
			return true
		},
	},

	[ChampionKey.Ashe]: {
		cast: (elapsedMS, spell, champion) => {
			if (!champion.target) { return false }
			const arrowCount = champion.getSpellVariable(spell, 'NumOfArrows')
			const attackSpeedPercent = champion.getSpellVariable(spell, 'ASReduction')
			const slowSeconds = champion.getSpellCalculationResult(spell, SpellKey.Duration)
			const radiansBetweenOrbs = toRadians(10) //NOTE hardcoded
			const fixedHexRange = champion.range() + 1
			getProjectileSpread(arrowCount, radiansBetweenOrbs).forEach(changeRadians => {
				champion.queueProjectileEffect(elapsedMS, spell, {
					fixedHexRange,
					destroysOnCollision: false,
					changeRadians,
					statusEffects: [
						[StatusEffectType.attackSpeedSlow, { amount: attackSpeedPercent, durationMS: slowSeconds * 1000 }],
					],
				})
			})
			return true
		},
	},

	[ChampionKey.Brand]: {
		cast: (elapsedMS, spell, champion) => {
			const target = getDistanceUnitOfTeam(false, champion, champion.opposingTeam())
			if (!target) return false
			if (isVIPActiveFor(champion)) {
				const alternativeTargets = getAttackableUnitsOfTeam(champion.opposingTeam()).filter(unit => unit !== target)
				const secondTarget = getBestRandomAsMax(false, alternativeTargets, (unit) => unit.coordDistanceSquaredTo(champion) + (unit.statusEffects.ablaze.active ? 0 : 1))
				const reducedDamagePercent = champion.getSpellVariable(spell, 'VIPBonusReducedDamage')
				if (secondTarget) {
					queueBrandFireball(elapsedMS, spell, champion, secondTarget, { multiplier: -reducedDamagePercent / 100 })
				}
			}
			return queueBrandFireball(elapsedMS, spell, champion, target)
		},
	},

	[ChampionKey.Corki]: {
		cast: (elapsedMS, spell, champion) => {
			const hexRange = 1 //NOTE hardcoded
			return champion.queueProjectileEffect(elapsedMS, spell, {
				hexEffect: {
					hexDistanceFromSource: hexRange,
				},
			})
		},
	},

	[ChampionKey.Draven]: {
		innate: (spell, champion) => {
			const armorPenPercent = champion.getSpellVariable(spell, 'PassiveArmorPenPercent')
			if (isVIPActiveFor(champion)) {
				return [
					[BonusKey.ArmorShred, (armorPenPercent + champion.getSpellVariable(spell, 'ArmorPenPercent')) / 100],
					[BonusKey.HexRangeIncrease, MAX_HEX_COUNT],
				]
			}
			return [
				[BonusKey.ArmorShred, armorPenPercent / 100],
			]
		},
		cast: (elapsedMS, spell, champion) => {
			addDravenAxe(elapsedMS, spell, champion)
			return true
		},
	},

	[ChampionKey.Gnar]: {
		cast: (elapsedMS, spell, champion) => {
			const boulderSpell = champion.data.spells[1]
			if (!champion.castCount) {
				const rangeReduction = 2 //NOTE hardcoded
				const transformSeconds = champion.getSpellVariable(spell, 'TransformDuration')
				const bonusHealth = champion.getSpellCalculationResult(spell, 'TransformHealth')
				const manaReduction = champion.getSpellVariable(spell, 'TransformManaReduc')
				const expiresAt = elapsedMS + transformSeconds * 1000
				champion.increaseMaxHealthBy(bonusHealth)
				champion.setBonusesFor(spell.name as BonusLabelKey, [BonusKey.ManaReduction, manaReduction, expiresAt], [BonusKey.HexRangeIncrease, -rangeReduction, expiresAt])
				if (champion.target) {
					const jumpToHex = champion.projectHexFrom(champion.target, false, 1)
					if (jumpToHex) {
						champion.customMoveTo(jumpToHex, false, 1000, undefined, false) //TODO travel time
					}
				}
			}
			const fixedHexRange = champion.data.stats.range
			const target = getDistanceUnitOfTeamWithinRangeTo(true, champion, fixedHexRange, getAttackableUnitsOfTeam(champion.opposingTeam()))
			champion.queueProjectileEffect(elapsedMS, spell, {
				target,
				missile: boulderSpell.missile,
				fixedHexRange,
				destroysOnCollision: false,
			})
			return true
		},
	},

	[ChampionKey.Irelia]: {
		cast: (elapsedMS, spell, champion) => {
			const target = champion.target
			if (!target) { return false }
			const moveSpeed = 2000 //TODO experimentally determine
			champion.manaLockUntilMS = Number.MAX_SAFE_INTEGER
			return ireliaResetRecursive(spell, champion, moveSpeed, target)
		},
	},

	[ChampionKey.JarvanIV]: {
		cast: (elapsedMS, spell, champion) => {
			const hexRadius = champion.getSpellVariable(spell, 'HexRadius')
			const durationSeconds = champion.getSpellVariable(spell, SpellKey.Duration)
			const attackSpeedProportion = champion.getSpellVariable(spell, 'ASPercent')
			return champion.queueHexEffect(elapsedMS, spell, {
				targetTeam: champion.team,
				hexDistanceFromSource: hexRadius as SurroundingHexRange,
				bonuses: [spell.name as BonusLabelKey, [BonusKey.AttackSpeed, attackSpeedProportion * 100, elapsedMS + durationSeconds * 1000]],
				opacity: 0.75,
			})
		},
	},

	[ChampionKey.KhaZix]: {
		cast: (elapsedMS, spell, champion) => {
			if (!champion.target) { return false }
			const manaReave = champion.getSpellVariable(spell, SpellKey.ManaReave)
			const jumpMS = champion.getSpellVariable(spell, 'MSBuff')
			return champion.queueMoveUnitEffect(elapsedMS, spell, {
				target: champion,
				targetTeam: champion.team,
				idealDestination: (champion) => {
					const validUnits = getAttackableUnitsOfTeam(champion.opposingTeam()).filter(unit => unit !== champion.target)
					const bestUnits = getBestArrayAsMax(false, validUnits, (unit) => unit.health)
					return getBestRandomAsMax(true, bestUnits, (unit) => unit.coordDistanceSquaredTo(champion)) ?? champion.target
				},
				moveDurationMS: jumpMS,
				onDestination: (elapsedMS, champion) => {
					champion.queueProjectileEffect(elapsedMS, spell, {
						bonuses: [SpellKey.ManaReave, [BonusKey.ManaReductionPercent, -manaReave]],
					})
				},
			})
		},
	},

	[ChampionKey.Lucian]: {
		cast: (elapsedMS, spell, champion) => {
			const target = champion.target
			if (!target) { return false }
			return champion.queueMoveUnitEffect(elapsedMS, spell, {
				target: champion,
				idealDestination: (champion) => {
					const hexMoveDistance = 2 //NOTE hardcoded
					const dashHexes = getHexRing(champion.activeHex, hexMoveDistance)
					return getBestHexWithinRangeTo(target, champion.range(), dashHexes)
				},
				moveSpeed: 1500, //TODO experimentally determine
				onDestination: (elapsedMS, champion) => {
					const otherValidTargets = getAttackableUnitsOfTeam(champion.opposingTeam()).filter(unit => unit !== target)
					const priorityTargets = getBestSortedAsMax(false, otherValidTargets, (unit) => unit.coordDistanceSquaredTo(champion))
					priorityTargets.unshift(target)
					const shotCount = champion.getSpellVariable(spell, 'NumShots')
					const missile = champion.getMissileWithSuffix('PassiveShot2')
					priorityTargets
						.slice(0, shotCount)
						.forEach((unit, targetIndex) => {
							champion.queueProjectileEffect(elapsedMS, spell, {
								startsAfterMS: targetIndex * DEFAULT_CAST_SECONDS * 1000,
								target: unit,
								missile,
								destroysOnCollision: true, //TODO verify
							})
						})
				},
			})
		},
	},

	[ChampionKey.Morgana]: {
		cast: (elapsedMS, spell, champion) => {
			const shieldAmount = champion.getSpellCalculationResult(spell, 'ShieldAmount')
			const shieldSeconds = champion.getSpellVariable(spell, 'ShieldDuration')
			const targetsInHexRange = champion.getSpellVariable(spell, 'Radius')
			const expiresAfterMS = shieldSeconds * 1000
			const tickEveryMS = 1000
			const effect = champion.queueTargetEffect(elapsedMS, spell, {
				targetsInHexRange,
				damageCalculation: champion.getSpellCalculation(spell, 'DamagePerSecond'),
				tickEveryMS,
				expiresAfterMS,
			})
			champion.queueShield(elapsedMS, champion, {
				amount: shieldAmount,
				expiresAfterMS,
				onRemoved: (elapsedMS, shield) => {
					if (shield.amount != null && shield.amount > 0) {
						if (effect) {
							const stunMS = champion.getSpellVariable(spell, SpellKey.StunDuration) * 1000
							effect.currentTargets.forEach(unit => unit.applyStatusEffect(elapsedMS, StatusEffectType.stunned, stunMS))
						}
					} else {
						const manaRefund = champion.getSpellVariable(spell, 'RefundedMana')
						champion.addMana(manaRefund)
					}
				},
			})
			return true
		},
	},

	[ChampionKey.Nocturne]: {
		cast: (elapsedMS, spell, champion) => {
			const stunSeconds = champion.getSpellVariable(spell, SpellKey.StunDuration)
			const durationMS = stunSeconds * 1000
			const tickEveryMS = 100 //TODO verify
			return champion.queueTargetEffect(elapsedMS, spell, {
				tickEveryMS,
				expiresAfterMS: durationMS,
				statusEffects: [
					[StatusEffectType.stunned, { durationMS }],
				],
			})
		},
	},

	[ChampionKey.RekSai]: {
		cast: (elapsedMS, spell, champion) => {
			return champion.queueProjectileEffect(elapsedMS, spell, {
				onCollided: (elapsedMS, effect, withUnit) => {
					const healAmount = champion.getSpellCalculationResult(spell, (withUnit.hitBy.has(champion.instanceID) ? 'HealBonus' : 'Heal') as SpellKey)
					champion.gainHealth(elapsedMS, champion, healAmount, true)
				},
			})
		},
	},

	[ChampionKey.Renata]: {
		cast: (elapsedMS, spell, champion) => {
			const targetTeam = champion.opposingTeam()
			const fixedHexRange = champion.getSpellVariable(spell, 'SpellRange')
			const validUnits = getAttackableUnitsOfTeam(targetTeam).filter(unit => unit.hexDistanceTo(champion) <= fixedHexRange)
			const bestHex = randomItem(getBestDensityHexes(true, validUnits, true, 1)) //TODO experimentally determine
			if (!bestHex) { return false }
			const attackSpeedReducePercent = champion.getSpellVariable(spell, 'ASReduction')
			const durationSeconds = champion.getSpellVariable(spell, SpellKey.Duration)
			const damageCalculation = champion.getSpellCalculation(spell, 'DamagePerSecond')
			if (!damageCalculation) return true
			return champion.queueProjectileEffect(elapsedMS, spell, {
				target: bestHex,
				fixedHexRange,
				destroysOnCollision: false,
				onCollided: (elapsedMS, effect, withUnit) => {
					withUnit.setBonusesFor(spell.name as BonusLabelKey, [BonusKey.AttackSpeed, -attackSpeedReducePercent, elapsedMS + durationSeconds * 1000])
					withUnit.bleeds.add({
						sourceID: Math.random().toString(),
						source: champion,
						damageCalculation,
						activatesAtMS: elapsedMS,
						repeatsEveryMS: 1000, //NOTE hardcoded
						remainingIterations: durationSeconds,
					})
				},
			})
		},
	},

	[ChampionKey.Sejuani]: {
		passiveCasts: true,
		passive: (elapsedMS, spell, target, champion, damage) => { //TODO verify if basic attack physical damage is applied
			const statsSeconds = champion.getSpellVariable(spell, SpellKey.Duration)
			const statsAmount = champion.getSpellVariable(spell, 'DefensiveStats')
			const stunSeconds = champion.getSpellVariable(spell, 'StunDuration')
			const damageCalculation = champion.getSpellCalculation(spell, SpellKey.Damage)
			target.applyStatusEffect(elapsedMS, StatusEffectType.stunned, stunSeconds * 1000)
			if (damageCalculation) {
				target.damage(elapsedMS, false, champion, DamageSourceType.spell, damageCalculation, false)
			}
			const expiresAtMS = elapsedMS + statsSeconds * 1000
			champion.addBonuses(spell.name as BonusLabelKey, [BonusKey.Armor, statsAmount, expiresAtMS], [BonusKey.MagicResist, statsAmount, expiresAtMS])
		},
	},

	[ChampionKey.Senna]: {
		cast: (elapsedMS, spell, champion) => {
			if (!champion.target) { return false }
			return champion.queueProjectileEffect(elapsedMS, spell, {
				destroysOnCollision: false,
				fixedHexRange: MAX_HEX_COUNT,
				hasBackingVisual: true,
				onCollided: (elapsedMS, effect, withUnit, damage) => {
					if (damage == null) { return }
					const lowestHPAlly = getBestRandomAsMax(false, champion.alliedUnits(true), (unit) => unit.health)
					if (lowestHPAlly) {
						const percentHealing = champion.getSpellCalculationResult(spell, 'PercentHealing')
						lowestHPAlly.gainHealth(elapsedMS, champion, damage.takingDamage * percentHealing / 100, true)
					}
				},
			})
		},
	},

	[ChampionKey.Silco]: {
		cast: (elapsedMS, spell, champion) => {
			const bonusLabelKey = spell.name as BonusLabelKey
			const numTargets = champion.getSpellVariable(spell, 'NumTargets')
			const validTargets = champion.alliedUnits(true).filter(unit => !unit.getBonusesFrom(bonusLabelKey).length)
			const lowestHPAllies = getBestSortedAsMax(false, validTargets, (unit) => unit.health) //TODO can self-target?
				.slice(0, numTargets)
			if (!lowestHPAllies.length) {
				return false
			}
			const durationMS = champion.getSpellVariable(spell, SpellKey.Duration) * 1000
			const maxHealthProportion = champion.getSpellVariable(spell, 'MaxHealth')
			const missile = champion.getMissileWithSuffix('R_Mis')
			lowestHPAllies.forEach(target => {
				champion.queueProjectileEffect(elapsedMS, spell, {
					target,
					targetTeam: champion.team,
					missile,
					onCollided: (elapsedMS, effect, withUnit) => {
						const attackSpeedProportion = champion.getSpellVariable(spell, SpellKey.AttackSpeed)
						withUnit.setBonusesFor(bonusLabelKey, [BonusKey.AttackSpeed, attackSpeedProportion * 100, elapsedMS + durationMS])
						target.applyStatusEffect(elapsedMS, StatusEffectType.ccImmune, durationMS)
						const healthIncrease = target.healthMax * maxHealthProportion
						target.healthMax += healthIncrease
						target.health += healthIncrease

						target.queueHexEffect(elapsedMS, undefined, {
							startsAfterMS: durationMS,
							hexDistanceFromSource: 2 * (champion.starLevel === 3 ? 2 : 1) as SurroundingHexRange,
							damageCalculation: champion.getSpellCalculation(spell, SpellKey.Damage),
							onActivate: (elapsedMS, target) => {
								target.die(elapsedMS, undefined)
							},
						})
					},
				})
			})
			return true
		},
	},

	[ChampionKey.Sivir]: {
		cast: (elapsedMS, spell, champion) => {
			const empowerSeconds = champion.getSpellVariable(spell, SpellKey.Duration)
			const bounceCount = champion.getSpellVariable(spell, 'NumBounces')
			const maxHexRangeFromOriginalTarget = champion.getSpellVariable(spell, 'BounceRange')
			const damageCalculation = champion.getSpellCalculation(spell, 'DamageCalc')
			const attackSpeedProportion = champion.getSpellCalculationResult(spell, 'BonusAttackSpeed')
			const expiresAtMS = elapsedMS + empowerSeconds * 1000
			champion.setBonusesFor(spell.name as BonusLabelKey, [BonusKey.AttackSpeed, attackSpeedProportion, expiresAtMS])
			champion.empoweredAutos.add({
				amount: 9001,
				expiresAtMS,
				bounce: {
					maxHexRangeFromOriginalTarget,
					bouncesRemaining: bounceCount,
					damageCalculation,
				},
			})
			champion.manaLockUntilMS = expiresAtMS
			return true
		},
	},

	[ChampionKey.Syndra]: {
		cast: (elapsedMS, spell, champion) => {
			const target = getDistanceUnitOfTeam(false, champion, champion.opposingTeam())
			if (!target) { return false }
			const targetStunSeconds = champion.getSpellVariable(spell, SpellKey.StunDuration)
			const aoeStunSeconds = champion.getSpellVariable(spell, 'VIPDebutantBonus')
			const isVIP = isVIPActiveFor(champion)
			return champion.queueMoveUnitEffect(elapsedMS, spell, {
				target,
				moveSpeed: 1000, //TODO experimentally determine
				hexEffect: {
					hexDistanceFromSource: !isVIP ? 1 : 2,
					statusEffects: !isVIP
						? undefined
						: [
							[StatusEffectType.stunned, { durationMS: aoeStunSeconds * 1000 }],
						],
				},
				idealDestination: (target) => getDistanceUnitOfTeam(true, champion, champion.opposingTeam())?.activeHex,
				statusEffects: [
					[StatusEffectType.stunned, { durationMS: targetStunSeconds * 1000 }],
				],
			})
		},
	},

	[ChampionKey.Tryndamere]: {
		cast: (elapsedMS, spell, champion) => {
			const densestEnemyHexes = getBestDensityHexes(true, getInteractableUnitsOfTeam(champion.opposingTeam()), true, 1)
			const farthestDenseHex = getDistanceHex(true, champion, densestEnemyHexes)
			if (!farthestDenseHex) { console.log('ERR', champion.data.name, spell.name, densestEnemyHexes) }
			const projectedHex = champion.projectHexFrom(farthestDenseHex ?? champion.activeHex, true, 1)
			if (!projectedHex) { console.log('ERR', champion.data.name, spell.name, farthestDenseHex) }
			return champion.queueShapeEffect(elapsedMS, spell, {
				shape: new ShapeEffectCircle(champion, HEX_MOVE_LEAGUEUNITS),
				expiresAfterMS: 0.5 * 1000, //TODO calculate
				onActivate: (elapsedMS, champion) => {
					champion.customMoveTo(projectedHex ?? champion, false, 2000, undefined, false) //TODO experimentally determine
					champion.empoweredAutos.add({
						amount: 3, //NOTE hardcoded
						damageModifier: {
							multiplier: champion.getSpellVariable(spell, 'BonusAAPercent'),
						},
					})
				},
			})
		},
	},

	[ChampionKey.Vi]: {
		cast: (elapsedMS, spell, champion) => {
			const target = champion.target
			if (!target || !champion.wasInRangeOfTarget) { return false }
			const castVariation = champion.castCount % 3
			const moveMissile = champion.getMissileWithSuffix('EFx')
			const moveSpeed = moveMissile?.speedInitial
			const shieldAmount = champion.getSpellCalculationResult(spell, 'Shield')
			const shieldSeconds = champion.getSpellVariable(spell, 'ShieldDuration')
			const shield: ShieldData = {
				id: ChampionKey.Vi,
				amount: shieldAmount,
				expiresAfterMS: shieldSeconds * 1000,
			}
			if (castVariation < 2) {
				champion.queueShapeEffect(elapsedMS, spell, {
					shape: new ShapeEffectCone(champion, false, target, HEX_MOVE_LEAGUEUNITS * 3, toRadians(60)), //TODO experimentally determine
					onActivate: (elapsedMS, champion) => {
						champion.queueShield(elapsedMS, champion, shield)
					},
				})
				if (castVariation === 1) {
					champion.queueMoveUnitEffect(elapsedMS, spell, {
						target: champion,
						idealDestination: () => champion.projectHexFrom(target, true, 1),
						moveSpeed,
					})
				}
			} else {
				const hexRadius = champion.getSpellVariable(spell, 'AoEHexRadius')
				const thirdCastSpell = champion.getSpellWithSuffix('_Spell_ThirdCast')
				champion.queueMoveUnitEffect(elapsedMS, thirdCastSpell, {
					target,
					movesWithTarget: true,
					idealDestination: () => champion.projectHexFrom(target, true, 1),
					moveSpeed,
					hexEffect: {
						hexDistanceFromSource: hexRadius as SurroundingHexRange,
						damageCalculation: champion.getSpellCalculation(spell, 'DamageFinal'),
					},
					onActivate: (elapsedMS, champion) => {
						champion.queueShield(elapsedMS, champion, shield)
					},
				})
			}
			return true
		},
	},

	[ChampionKey.Zeri]: {
		customAuto: (elapsedMS, spell, target, champion, empoweredAuto, windupMS) => {
			//TODO target farthest enemy
			if (empoweredAuto.damageCalculation != null || empoweredAuto.destroysOnCollision != null || empoweredAuto.stackingDamageModifier != null || empoweredAuto.missile != null || empoweredAuto.hexEffect != null) {
				console.warn('empoweredAuto cannot modify', empoweredAuto)
			}
			const bulletCount = champion.getSpellVariable(spell, 'NumBullets')
			const missile = champion.getMissileWithSuffix('QMis')
			const fixedHexRange = champion.range()
			const radiansBetween = Math.PI / 128 //TODO experimentally determine

			const damageCalculation = champion.getSpellCalculation(spell, SpellKey.Damage)
			const bonusCalculations = empoweredAuto.bonusCalculations ?? []
			const onHitBonus = champion.getSpellCalculation(spell, 'BonusOnHit')
			if (onHitBonus) { bonusCalculations.push(onHitBonus) }

			getProjectileSpread(bulletCount, radiansBetween).forEach((changeRadians, bulletIndex) => {
				champion.queueProjectileEffect(elapsedMS, undefined, {
					target: target.activeHex,
					startsAfterMS: windupMS,
					damageSourceType: DamageSourceType.attack,
					missile,
					destroysOnCollision: !champion.statusEffects.empowered.active,
					changeRadians,
					fixedHexRange,
					damageCalculation,
					bonusCalculations,
					damageModifier: empoweredAuto.damageModifier,
					statusEffects: empoweredAuto.statusEffects,
					bounce: empoweredAuto.bounce,
					bonuses: empoweredAuto.bonuses,
					opacity: 1 / 3,
					onActivate: (elapsedMS, champion) => {
						if (bulletIndex === 0 && champion.statusEffects.empowered.active) {
							champion.queueMoveUnitEffect(elapsedMS, undefined, {
								target: champion,
								idealDestination: () => getDistanceHex(true, target, getHexesSurroundingWithin(champion.activeHex, 2, false)), //TODO experimentally determine
								moveSpeed: 2000, //TODO experimentally determine
								keepsAttackTarget: true,
							})
						}
					},
					onCollided(elapsedMS, effect, withUnit, damage) {
						if (bulletIndex === 0) {
							champion.completeAutoAttack(elapsedMS, effect, withUnit, damage, empoweredAuto, true)
						}
					},
				})
			})
		},
		cast: (elapsedMS, spell, champion) => {
			const castSeconds = 1 //TODO experimentally determine
			delayUntil(elapsedMS, castSeconds).then(elapsedMS => {
				const durationSeconds = isVIPActiveFor(champion) ? champion.getSpellVariable(spell, 'VIPTotalDuration') : champion.getSpellVariable(spell, SpellKey.Duration)
				champion.applyStatusEffect(elapsedMS, StatusEffectType.empowered, durationSeconds * 1000)
				champion.manaLockUntilMS = elapsedMS + durationSeconds * 1000
			})
			champion.performActionUntilMS = elapsedMS + castSeconds * 1000
			return true
		},
	},

} as ChampionEffects

function ireliaResetRecursive(spell: ChampionSpellData, champion: ChampionUnit, moveSpeed: number, target: ChampionUnit) {
	champion.customMoveTo(target, false, moveSpeed, undefined, false, (elapsedMS, champion) => {
		if (target.isAttackable()) {
			const damageCalculation = champion.getSpellCalculation(spell, SpellKey.Damage)
			if (damageCalculation) {
				target.damage(elapsedMS, true, champion, DamageSourceType.spell, damageCalculation, false)
				if (target.dead) {
					const newTarget = getBestRandomAsMax(false, getAttackableUnitsOfTeam(target.team), (unit) => unit.health)
					if (newTarget) {
						return ireliaResetRecursive(spell, champion, moveSpeed, newTarget)
					}
				}
			}
		}
		champion.customMoveTo(target, true, moveSpeed, undefined, false, (elapsedMS, champion) => {
			champion.manaLockUntilMS = 0
		})
	})
	return true
}

function addDravenAxe(elapsedMS: DOMHighResTimeStamp, spell: ChampionSpellData, champion: ChampionUnit) {
	const id = ChampionKey.Draven
	const existingAxe = Array.from(champion.empoweredAutos).find(empoweredAuto => empoweredAuto.id === id)
	const returnMissile = champion.getMissileWithSuffix('SpinningReturn')
	const durationSeconds = champion.getSpellVariable(spell, 'BuffDuration')
	const expiresAtMS = elapsedMS + durationSeconds * 1000
	if (existingAxe) {
		if (existingAxe.amount < 2) { //NOTE hardcoded
			existingAxe.amount += 1
		}
		existingAxe.expiresAtMS = expiresAtMS //TODO axes should technically expire individually
	} else {
		champion.empoweredAutos.add({
			id,
			amount: 1,
			expiresAtMS,
			returnMissile, //TODO fixed 2s travel time
			returnDoesNotTrack: true,
			onCollided: (elapsedMS, effect, withUnit) => {
				if (withUnit === champion && effect.intersects(champion)) {
					addDravenAxe(elapsedMS, spell, champion)
				}
			},
		})
	}
}

function queueBrandFireball(elapsedMS: DOMHighResTimeStamp, spell: ChampionSpellData, champion: ChampionUnit, target: ChampionUnit, damageModifier?: DamageModifier) {
	champion.queueProjectileEffect(elapsedMS, spell, {
		target,
		destroysOnCollision: true,
		damageModifier,
		onCollided: (elapsedMS, effect, withUnit) => {
			if (withUnit.statusEffects.ablaze.active) {
				withUnit.statusEffects.ablaze.active = false
				const bonusCalculation = champion.getSpellCalculation(spell, 'BonusDamage')
				if (bonusCalculation) {
					withUnit.takeBonusDamage(elapsedMS, champion, bonusCalculation, false)
				}
				const secondProcStunSeconds = champion.getSpellVariable(spell, SpellKey.StunDuration)
				withUnit.applyStatusEffect(elapsedMS, StatusEffectType.stunned, secondProcStunSeconds * 1000)
			} else {
				const blazeSeconds = champion.getSpellVariable(spell, 'BlazeDuration')
				withUnit.applyStatusEffect(elapsedMS, StatusEffectType.ablaze, blazeSeconds * 1000)
			}
		},
	})
}
