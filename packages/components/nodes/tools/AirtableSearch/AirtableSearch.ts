import axios from 'axios'
import { z } from 'zod/v3'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { ICommonObject, INode, INodeData, INodeParams } from '../../../src/Interface'
import { getCredentialData, getCredentialParam } from '../../../src/utils'

const DEFAULT_DESCRIPTION = `Search the campaigns Airtable using structured preferences and lexical relevance. The result includes a databaseDictionary that distinguishes controlled/faceted fields from descriptive narrative fields. Read it before ranking: use enum-like fields as evidence and soft facets, and Description/BoardDescription for mechanisms, contexts and creative analogies. For a normal campaign request, make one broad call alongside vector_search and request 15–20 candidates; do not re-query this tool once per vector candidate. By default, year, award/festival, client, country, category and audience improve ranking but do not exclude useful adjacent results. Use strict mode only when the user explicitly requires every supplied filter. The result is authoritative for the records it returns.`

const normalize = (value: unknown): string =>
    String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()

const flatten = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(flatten).join(' ')
    if (value && typeof value === 'object')
        return Object.values(value as Record<string, unknown>)
            .map(flatten)
            .join(' ')
    return String(value ?? '')
}

const fieldText = (fields: ICommonObject, keyPattern: RegExp): string =>
    Object.entries(fields)
        .filter(([key]) => keyPattern.test(normalize(key)))
        .map(([, value]) => flatten(value))
        .join(' ')

const matches = (haystack: string, needle?: string | number): boolean => !needle || normalize(haystack).includes(normalize(needle))

const preferenceMatches = (haystack: string, needle?: string | number): boolean => {
    if (!needle) return true
    const normalizedHaystack = normalize(haystack)
    const normalizedNeedle = normalize(needle)
    if (normalizedHaystack.includes(normalizedNeedle)) return true

    const meaningfulTerms = normalizedNeedle.split(' ').filter((term) => term.length > 3 && !PREFERENCE_STOP_WORDS.has(term))
    const haystackTerms = new Set(normalizedHaystack.split(' '))
    return meaningfulTerms.some((term) => haystackTerms.has(term))
}

const compactFields = (fields: ICommonObject): ICommonObject =>
    Object.fromEntries(
        Object.entries(fields).map(([key, value]) => {
            if (typeof value !== 'string' || value.length <= 1600 || /(url|link|video|board)/.test(normalize(key))) return [key, value]
            return [key, `${value.slice(0, 1600)}…`]
        })
    )

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

const PREFERENCE_STOP_WORDS = new Set([
    ...STOP_WORDS,
    'activation',
    'brand',
    'campaign',
    'campaigns',
    'creative',
    'experience',
    'marketing',
    'retail',
    'service',
    'services'
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

interface AirtableFieldChoice {
    name: string
}

interface AirtableFieldSchema {
    id: string
    name: string
    type: string
    options?: {
        choices?: AirtableFieldChoice[]
    }
}

interface AirtableTableSchema {
    id: string
    name: string
    fields: AirtableFieldSchema[]
}

interface AirtableBaseSchemaResponse {
    tables: AirtableTableSchema[]
}

type FieldRole = 'facet' | 'narrative' | 'identity' | 'media' | 'other'

const classifyField = (name: string, type?: string): FieldRole => {
    const normalizedName = normalize(name)
    if (/(description|board description|summary|idea|insight|execution|mechanism|opis)/.test(normalizedName)) return 'narrative'
    if (/(url|link|video|board url|case film|attachment|image|thumbnail)/.test(normalizedName)) return 'media'
    if (/(^| )(name|title|client|brand|agency|year|date)( |$)/.test(normalizedName)) return 'identity'
    if (
        ['singleSelect', 'multipleSelects', 'checkbox', 'rating'].includes(type || '') ||
        /(^| )(audience|category|tag|country|market|region|award|festival|sector|industry|vertical)( |$)/.test(normalizedName)
    )
        return 'facet'
    return 'other'
}

const collectObservedValues = (records: AirtableRecord[], fieldName: string): string[] => {
    const values = new Set<string>()
    for (const record of records) {
        const rawValue = record.fields[fieldName]
        const candidates = Array.isArray(rawValue) ? rawValue : [rawValue]
        for (const candidate of candidates) {
            if (candidate === undefined || candidate === null || typeof candidate === 'object') continue
            const value = String(candidate).trim()
            if (value && value.length <= 120) values.add(value)
            if (values.size >= 60) return [...values]
        }
    }
    return [...values]
}

const buildDatabaseDictionary = (records: AirtableRecord[], metadataFields?: AirtableFieldSchema[]) => {
    const fieldNames = new Set<string>()
    for (const record of records) Object.keys(record.fields).forEach((field) => fieldNames.add(field))

    const metadataByName = new Map((metadataFields || []).map((field) => [field.name, field]))
    for (const field of metadataFields || []) fieldNames.add(field.name)

    const fields = [...fieldNames].map((name) => {
        const metadata = metadataByName.get(name)
        const role = classifyField(name, metadata?.type)
        const declaredChoices = metadata?.options?.choices?.map((choice) => choice.name).filter(Boolean) || []
        const observedValues = role === 'facet' ? collectObservedValues(records, name) : []
        return {
            name,
            type:
                metadata?.type ||
                (records.some((record) => Array.isArray(record.fields[name])) ? 'observedMultipleValues' : 'observedValue'),
            role,
            ...(declaredChoices.length ? { enumValues: declaredChoices.slice(0, 80) } : {}),
            ...(observedValues.length ? { observedValues: observedValues.slice(0, 40) } : {})
        }
    })

    return {
        source: metadataFields?.length ? 'airtable_metadata_api' : 'inferred_from_scanned_records',
        usage: {
            facet: 'Controlled or repeated vocabulary. Use for exact evidence and soft ranking; do not require an exact label unless the user says only/must.',
            narrative:
                'Free text. Search Description and BoardDescription for insight, mechanism, execution, setting and lateral creative analogies.',
            identity: 'Grounded facts such as campaign name, client, agency and year.',
            media: 'Grounded case-board/video assets; never invent or repair URLs.'
        },
        semanticVectorFields: [
            'Name',
            'Client',
            'Agency',
            'Year',
            'Country',
            'Award',
            'Category',
            'Audience',
            'Tag',
            'Description',
            'BoardDescription',
            'VideoUrl',
            'BoardURL'
        ],
        fields
    }
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
            limit: z.number().int().min(1).max(30).optional().default(18).describe('Maximum number of records to return')
        })

        const func = async (input: z.infer<typeof schema>): Promise<string> => {
            const records: AirtableRecord[] = []
            let offset: string | undefined
            let metadataFields: AirtableFieldSchema[] | undefined

            try {
                const metadataResponse = await axios.get<AirtableBaseSchemaResponse>(
                    `https://api.airtable.com/v0/meta/bases/${encodeURIComponent(baseId)}/tables`,
                    { headers: { Authorization: `Bearer ${accessToken}` } }
                )
                const tableSchema = metadataResponse.data.tables.find((table) => table.id === tableId || table.name === tableId)
                metadataFields = tableSchema?.fields
            } catch {
                // Some valid Airtable tokens intentionally omit schema.bases:read.
                // In that case the dictionary is inferred from the records below.
            }

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
                        { name: 'year', value: input.year, text: yearText || allText, weight: 30, broad: false },
                        { name: 'award', value: input.award, text: `${awardText} ${allText}`, weight: 30, broad: true },
                        { name: 'category', value: input.category, text: `${categoryText} ${allText}`, weight: 20, broad: true },
                        { name: 'audience', value: input.audience, text: `${audienceText} ${allText}`, weight: 15, broad: true },
                        { name: 'client', value: input.client, text: clientText || allText, weight: 25, broad: false },
                        { name: 'country', value: input.country, text: countryText || allText, weight: 20, broad: false }
                    ].filter((filter) => filter.value !== undefined && filter.value !== '')
                    const matchedFilters = filterChecks.filter((filter) =>
                        filter.broad ? preferenceMatches(filter.text, filter.value) : matches(filter.text, filter.value)
                    )
                    const missingFilters = filterChecks.filter(
                        (filter) => !(filter.broad ? preferenceMatches(filter.text, filter.value) : matches(filter.text, filter.value))
                    )

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
                        fields: compactFields(record.fields)
                    }
                })
                .filter((record): record is NonNullable<typeof record> => record !== null)
                .sort((a, b) => b.score - a.score)
                .slice(0, input.limit ?? 18)

            return JSON.stringify({
                query: input,
                scannedRecords: Math.min(records.length, maxRecords),
                matchedRecords: ranked.length,
                databaseDictionary: buildDatabaseDictionary(records.slice(0, maxRecords), metadataFields),
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
