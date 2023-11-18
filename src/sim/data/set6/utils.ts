import { AugmentGroupKey, TraitKey } from '@tacticians-academy/academy-library'
import { ChampionKey } from '@tacticians-academy/academy-library/dist/set6.5/champions'

import { getters, state } from '#/store/store'

import type { ChampionUnit } from '#/sim/ChampionUnit'

import { getHexRing } from '#/sim/helpers/board'
import { getVariables } from '#/sim/helpers/effectUtils'
import { getMirrorHex, isSameHex } from '#/sim/helpers/hexes'
import type { HexCoord, TeamNumber } from '#/sim/helpers/types'

export const INNOVATION_IDS: string[] = [ChampionKey.MalzaharVoidling, ChampionKey.Tibbers, ChampionKey.HexTechDragon]

export function getSocialiteHexesFor(team: TeamNumber): [statMultiplier: number, hexes: HexCoord[]][] {
	const teamAugments = getters.activeAugmentEffectsByTeam.value[team]
	const duetAugment = teamAugments.find(([augment]) => augment.groupID === AugmentGroupKey.Duet)
	const shareTheSpotlightAugment = teamAugments.find(([augment]) => augment.groupID === AugmentGroupKey.ShareTheSpotlight)?.[0]
	const socialiteHexes = (duetAugment ? state.socialiteHexes : [state.socialiteHexes[0]]).filter((hex): hex is HexCoord => !!hex)
	const secondaryHexes = shareTheSpotlightAugment ? socialiteHexes.flatMap(hex => getHexRing(hex)) : []
	const sharePercent = shareTheSpotlightAugment ? getVariables(shareTheSpotlightAugment, 'PercentStats')[0] : 0
	return [[1, socialiteHexes], [sharePercent / 100, secondaryHexes]]
}

export function getUnitsInSocialiteHexes(team: TeamNumber, units: ChampionUnit[]): [statMultiplier: number, units: ChampionUnit[]][] {
	return getSocialiteHexesFor(team).map(([statsModifier, socialiteHexes]) => {
		return [statsModifier, units.filter(unit => {
			const mirrorHex = getMirrorHex(unit.startHex)
			return socialiteHexes.some(hex => isSameHex(hex, mirrorHex))
		})]
	})
}

export function isVIPActiveFor(unit: ChampionUnit) {
	return unit.stacks.Debonair?.amount === 1 && unit.activeSynergies.some(synergy => synergy.key === TraitKey.Debonair)
}
