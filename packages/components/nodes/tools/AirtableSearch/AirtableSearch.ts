import axios from 'axios'
import { z } from 'zod/v3'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { ICommonObject, INode, INodeData, INodeParams } from '../../../src/Interface'
import { getCredentialData, getCredentialParam } from '../../../src/utils'

const DEFAULT_DESCRIPTION = `Search the campaigns Airtable using structured preferences and lexical relevance. Call this tool for every campaign-search request, alongside vector_search. By default, year, award/festival, client, country, category and audience improve ranking but do not exclude useful adjacent results. Use strict mode only when the user explicitly requires every supplied filter. The result is authoritative for exact Airtable field values.`

const normalize = (value: unknown): string =>
    String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()

const flatten = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(flatten).join(' ')
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).map(flatten).join(' ')
    return String(value ?? '')
}

const fieldText = (fields: ICommonObject, keyPattern: RegExp): string =>
    Object.entries(fields)
        .filter(([key]) => keyPattern.test(normalize(key)))
        .map(([, value]) => flatten(value))
        .join(' ')

const matches = (haystack: string, needle?: string | number): boolean => !needle || normalize(haystack).includes(normalize(needle))

const STOP_WORDS = new Set([
    'a',
    'an',
    'and',
    'dla',
    'do',
    'find',
    'i',
    'in',
    'kampania',
    'kampanie',
    'kampanii',
    'me',
    'mi',
    'na',
    'o',
    'of',
    'oraz',
    'the',
    'w',
    'with',
    'wyszukaj',
    'znajdz',
    'z'
])

interface AirtableRecord {
    id: string
    createdTime?: string
    fields: ICommonObject
}

interface AirtableResponse {
    records: AirtableRecord[]
    offset?: string
}

class AirtableSearch_Tools implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'Airtable Search'
        this.name = 'airtableSearch'
        this.version = 1.0
        this.description = 'Native structured and keyword search over Airtable records'
        this.type = 'AirtableSearch'
        this.icon = 'airtable.svg'
        this.category = 'Tools'
        this.baseClasses = [this.type, 'Tool']
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['airtableApi']
        }
        this.inputs = [
            {
                label: 'Base Id',
                name: 'baseId',
                type: 'string',
                placeholder: 'app11RobdGoX0YNsC'
            },
            {
                label: 'Table Id',
                name: 'tableId',
                type: 'string',
                placeholder: 'tblJdmvbrgizbYICO'
            },
            {
                label: 'View Id',
                name: 'viewId',
                type: 'string',
                optional: true
            },
            {
                label: 'Include Only Fields',
                name: 'fields',
                type: 'string',
                optional: true,
                additionalParams: true,
                description: 'Comma-separated Airtable field names or IDs. Leave empty to search every field.'
            },
            {
                label: 'Maximum Records To Scan',
                name: 'maxRecords',
                type: 'number',
                default: 2000,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Tool Description',
                name: 'toolDescription',
                type: 'string',
                rows: 5,
                default: DEFAULT_DESCRIPTION,
                optional: true,
                additionalParams: true
            }
        ]
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const baseId = nodeData.inputs?.baseId as string
        const tableId = nodeData.inputs?.tableId as string
        const viewId = nodeData.inputs?.viewId as string
        const fieldsInput = nodeData.inputs?.fields as string
        const maxRecordsInput = nodeData.inputs?.maxRecords as string
        const description = (nodeData.inputs?.toolDescription as string) || DEFAULT_DESCRIPTION

        if (!baseId || !tableId) throw new Error('Base ID and Table ID must be provided.')

        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const accessToken = getCredentialParam('accessToken', credentialData, nodeData)
        const configuredFields = fieldsInput
            ? fieldsInput
                  .split(',')
                  .map((field) => field.trim())
                  .filter(Boolean)
            : []
        const maxRecords = Math.max(1, Math.min(parseInt(maxRecordsInput || '2000', 10), 10000))

        const schema = z.object({
            query: z.string().describe('Original campaign search request, retaining all important keywords'),
            year: z.union([z.string(), z.number()]).optional().describe('Preferred campaign or award year'),
            award: z.string().optional().describe('Preferred award or festival, for example Cannes Lions'),
            category: z.string().optional().describe('Preferred industry, sector or campaign category'),
            audience: z.string().optional().describe('Preferred target audience, for example Gen Z'),
            client: z.string().optional().describe('Preferred client or brand'),
            country: z.string().optional().describe('Preferred country or market'),
            strict: z
                .boolean()
                .optional()
                .default(false)
                .describe('Exclude records missing any supplied filter. Use only when the user explicitly forbids near matches.'),
            limit: z.number().int().min(1).max(100).optional().default(30).describe('Maximum number of records to return')
        })

        const func = async (input: z.infer<typeof schema>): Promise<string> => {
            const records: AirtableRecord[] = []
            let offset: string | undefined

            do {
                const params = new URLSearchParams()
                params.set('pageSize', '100')
                if (viewId) params.set('view', viewId)
                if (offset) params.set('offset', offset)
                for (const field of configuredFields) params.append('fields[]', field)

                const response = await axios.get<AirtableResponse>(
                    `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}?${params.toString()}`,
                    {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    }
                )

                records.push(...response.data.records)
                offset = response.data.offset
            } while (offset && records.length < maxRecords)

            const terms = normalize(input.query)
                .split(' ')
                .filter((term) => term.length > 1 && !STOP_WORDS.has(term))
            const normalizedQuery = normalize(input.query)

            const ranked = records
                .slice(0, maxRecords)
                .map((record) => {
                    const allText = normalize(flatten(record.fields))
                    const yearText = fieldText(record.fields, /(^| )(year|rok|date|award year)( |$)/)
                    const awardText = fieldText(record.fields, /(award|festival|cannes|nagrod)/)
                    const categoryText = fieldText(record.fields, /(category|sector|industry|vertical|kategor)/)
                    const audienceText = fieldText(record.fields, /(audience|target|demographic|consumer|grupa)/)
                    const clientText = fieldText(record.fields, /(client|brand|advertiser|marka|klient)/)
                    const countryText = fieldText(record.fields, /(country|market|region|kraj)/)

                    const filterChecks = [
                        { name: 'year', value: input.year, text: yearText || allText, weight: 30 },
                        { name: 'award', value: input.award, text: awardText || allText, weight: 30 },
                        { name: 'category', value: input.category, text: categoryText || allText, weight: 20 },
                        { name: 'audience', value: input.audience, text: audienceText || allText, weight: 15 },
                        { name: 'client', value: input.client, text: clientText || allText, weight: 25 },
                        { name: 'country', value: input.country, text: countryText || allText, weight: 20 }
                    ].filter((filter) => filter.value !== undefined && filter.value !== '')
                    const matchedFilters = filterChecks.filter((filter) => matches(filter.text, filter.value))
                    const missingFilters = filterChecks.filter((filter) => !matches(filter.text, filter.value))

                    if (input.strict && missingFilters.length) return null

                    let score = normalizedQuery && allText.includes(normalizedQuery) ? 80 : 0
                    const evidence: string[] = []
                    const weightedFields: Array<[RegExp, number]> = [
                        [/(^| )(name|title|campaign)( |$)/, 12],
                        [/(award|festival|cannes|nagrod)/, 10],
                        [/(client|brand|advertiser|marka|klient)/, 8],
                        [/(category|sector|industry|vertical|kategor)/, 7],
                        [/(audience|target|demographic|consumer|grupa)/, 7],
                        [/(description|summary|idea|insight|execution|opis)/, 4]
                    ]

                    for (const term of terms) {
                        if (allText.includes(term)) {
                            score += 2
                            evidence.push(term)
                        }
                        for (const [pattern, weight] of weightedFields) {
                            if (normalize(fieldText(record.fields, pattern)).includes(term)) score += weight
                        }
                    }

                    score += matchedFilters.reduce((total, filter) => total + filter.weight, 0)
                    score -= missingFilters.length * 3

                    return {
                        id: record.id,
                        score,
                        matchedTerms: [...new Set(evidence)],
                        matchedFilters: matchedFilters.map((filter) => filter.name),
                        missingFilters: missingFilters.map((filter) => filter.name),
                        fields: record.fields
                    }
                })
                .filter((record): record is NonNullable<typeof record> => record !== null)
                .sort((a, b) => b.score - a.score)
                .slice(0, input.limit ?? 30)

            return JSON.stringify({
                query: input,
                scannedRecords: Math.min(records.length, maxRecords),
                matchedRecords: ranked.length,
                records: ranked
            })
        }

        return new DynamicStructuredTool({
            name: 'airtable_search',
            description,
            schema,
            func
        })
    }
}

module.exports = { nodeClass: AirtableSearch_Tools }
