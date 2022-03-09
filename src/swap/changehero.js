// @flow

import { lt, mul } from 'biggystring'
import {
  type EdgeCorePluginOptions,
  type EdgeCurrencyWallet,
  type EdgeSpendInfo,
  type EdgeSwapPlugin,
  type EdgeSwapQuote,
  type EdgeSwapRequest,
  type EdgeTransaction,
  SwapBelowLimitError,
  SwapCurrencyError
} from 'edge-core-js/types'

import { makeSwapPluginQuote, safeCurrencyCodes } from '../swap-helpers.js'

const CURRENCY_CODE_TRANSCRIPTION = {
  ethereum: {
    USDT: 'USDT20'
  },
  avalanche: {
    AVAX: 'AVAXC'
  },
  binancesmartchain: {
    BNB: 'BNBBSC'
  },
  polygon: {
    MATIC: 'POLYGON'
  }
}

const pluginId = 'changehero'
const swapInfo: EdgeSwapInfo = {
  pluginId,
  displayName: 'ChangeHero',
  supportEmail: 'support@changehero.io'
}

// const orderUri = 'https://changehero.io/transaction/'
const uri = 'https://api.changehero.io/v2'
const expirationMs = 1000 * 60 * 20
const expirationFixedMs = 1000 * 60 * 5
type QuoteInfo = {
  id: string,
  payinExtraId: string | null,
  payoutExtraId: string | null,
  amountExpectedFrom: number,
  status: string,
  currencyFrom: string,
  currencyTo: string,
  amountTo: number,
  payinAddress: string,
  payoutAddress: string,
  createdAt: string
}
type FixedQuoteInfo = {
  id: string,
  amountExpectedFrom: string,
  amountExpectedTo: string,
  amountTo: number,
  createdAt: string,
  currencyFrom: string,
  currencyTo: string,
  payinAddress: string,
  payinExtraId: string | null,
  payoutAddress: string,
  payoutExtraId: string | null,
  refundAddress: string,
  refundExtraId: string | null,
  status: string
}

const dontUseLegacy = {
  DGB: true
}

async function getAddress(
  wallet: EdgeCurrencyWallet,
  currencyCode: string
): Promise<string> {
  const addressInfo = await wallet.getReceiveAddress({ currencyCode })
  return addressInfo.legacyAddress && !dontUseLegacy[currencyCode]
    ? addressInfo.legacyAddress
    : addressInfo.publicAddress
}

function checkReply(reply: Object, request: EdgeSwapRequest) {
  if (reply.error != null) {
    if (
      reply.error.code === -32602 ||
      /Invalid currency:/.test(reply.error.message)
    ) {
      throw new SwapCurrencyError(
        swapInfo,
        request.fromCurrencyCode,
        request.toCurrencyCode
      )
    }
    throw new Error('ChangeHero error: ' + JSON.stringify(reply.error))
  }
}

export function makeChangeHeroPlugin(
  opts: EdgeCorePluginOptions
): EdgeSwapPlugin {
  const { initOptions, io, log } = opts
  const { fetchCors = io.fetch } = io

  if (initOptions.apiKey == null) {
    throw new Error('No ChangeHero apiKey or secret provided.')
  }
  const { apiKey } = initOptions

  async function call(json: any) {
    const body = JSON.stringify(json)

    const headers = {
      'Content-Type': 'application/json',
      'api-key': apiKey
    }
    const response = await fetchCors(uri, { method: 'POST', body, headers })

    if (!response.ok) {
      throw new Error(`ChangeHero returned error code ${response.status}`)
    }
    return response.json()
  }

  const out: EdgeSwapPlugin = {
    swapInfo,
    async fetchSwapQuote(
      request: EdgeSwapRequest,
      userSettings: Object | void
    ): Promise<EdgeSwapQuote> {
      const fixedPromise = this.getFixedQuote(request, userSettings)
      // Estimated swaps disabled
      const fixedResult = await fixedPromise
      return fixedResult
    },
    async getFixedQuote(
      request: EdgeSwapRequest,
      userSettings: Object | void
    ): Promise<EdgeSwapQuote> {
      const [fromAddress, toAddress] = await Promise.all([
        getAddress(request.fromWallet, request.fromCurrencyCode),
        getAddress(request.toWallet, request.toCurrencyCode)
      ])
      const quoteAmount =
        request.quoteFor === 'from'
          ? await request.fromWallet.nativeToDenomination(
              request.nativeAmount,
              request.fromCurrencyCode
            )
          : await request.toWallet.nativeToDenomination(
              request.nativeAmount,
              request.toCurrencyCode
            )

      const { safeFromCurrencyCode, safeToCurrencyCode } = safeCurrencyCodes(
        CURRENCY_CODE_TRANSCRIPTION,
        request
      )

      const fixedRateQuote = await call({
        jsonrpc: '2.0',
        id: 'one',
        method: 'getFixRate',
        params: {
          from: safeFromCurrencyCode,
          to: safeToCurrencyCode
        }
      })

      const [{ id: responseId }] = fixedRateQuote.result
      const params =
        request.quoteFor === 'from'
          ? {
              amount: quoteAmount,
              from: safeFromCurrencyCode,
              to: safeToCurrencyCode,
              address: toAddress,
              extraId: null,
              refundAddress: fromAddress,
              refundExtraId: null,
              rateId: responseId
            }
          : {
              amountTo: quoteAmount,
              from: safeFromCurrencyCode,
              to: safeToCurrencyCode,
              address: toAddress,
              extraId: null,
              refundAddress: fromAddress,
              refundExtraId: null,
              rateId: responseId
            }

      const sendReply = await call({
        jsonrpc: '2.0',
        id: 2,
        method: 'createFixTransaction',
        params
      })
      checkReply(sendReply, request)
      const quoteInfo: FixedQuoteInfo = sendReply.result
      const spendInfoAmount = await request.fromWallet.denominationToNative(
        `${quoteInfo.amountExpectedFrom}`,
        request.fromCurrencyCode.toUpperCase()
      )

      const amountExpectedFromNative = await request.fromWallet.denominationToNative(
        `${sendReply.result.amountExpectedFrom}`,
        request.fromCurrencyCode
      )
      const amountExpectedToTo = await request.toWallet.denominationToNative(
        `${sendReply.result.amountExpectedTo}`,
        request.toCurrencyCode
      )

      const spendInfo: EdgeSpendInfo = {
        currencyCode: request.fromCurrencyCode,
        spendTargets: [
          {
            nativeAmount: spendInfoAmount,
            publicAddress: quoteInfo.payinAddress,
            uniqueIdentifier: quoteInfo.payinExtraId || undefined
          }
        ],
        networkFeeOption:
          request.fromCurrencyCode.toUpperCase() === 'BTC'
            ? 'high'
            : 'standard',
        swapData: {
          orderId: quoteInfo.id,
          isEstimate: false,
          payoutAddress: toAddress,
          payoutCurrencyCode: request.toCurrencyCode,
          payoutNativeAmount: amountExpectedToTo,
          payoutWalletId: request.toWallet.id,
          plugin: { ...swapInfo },
          refundAddress: fromAddress
        }
      }
      const tx: EdgeTransaction = await request.fromWallet.makeSpend(spendInfo)

      return makeSwapPluginQuote(
        request,
        amountExpectedFromNative,
        amountExpectedToTo,
        tx,
        toAddress,
        'changehero',
        false,
        new Date(Date.now() + expirationFixedMs),
        quoteInfo.id
      )
    },

    async getEstimate(
      request: EdgeSwapRequest,
      userSettings: Object | void
    ): Promise<EdgeSwapQuote> {
      // Grab addresses:
      const [fromAddress, toAddress] = await Promise.all([
        getAddress(request.fromWallet, request.fromCurrencyCode),
        getAddress(request.toWallet, request.toCurrencyCode)
      ])

      // Convert the native amount to a denomination:
      const quoteAmount =
        request.quoteFor === 'from'
          ? await request.fromWallet.nativeToDenomination(
              request.nativeAmount,
              request.fromCurrencyCode
            )
          : await request.toWallet.nativeToDenomination(
              request.nativeAmount,
              request.toCurrencyCode
            )

      let safeFromCurrencyCode = request.fromCurrencyCode
      let safeToCurrencyCode = request.toCurrencyCode
      if (CURRENCY_CODE_TRANSCRIPTION[request.fromCurrencyCode]) {
        safeFromCurrencyCode =
          CURRENCY_CODE_TRANSCRIPTION[request.fromCurrencyCode]
      }
      if (CURRENCY_CODE_TRANSCRIPTION[request.toCurrencyCode]) {
        safeToCurrencyCode = CURRENCY_CODE_TRANSCRIPTION[request.toCurrencyCode]
      }

      // Swap the currencies if we need a reverse quote:
      const quoteParams =
        request.quoteFor === 'from'
          ? {
              from: safeFromCurrencyCode,
              to: safeToCurrencyCode,
              amount: quoteAmount
            }
          : {
              from: safeToCurrencyCode,
              to: safeFromCurrencyCode,
              amount: quoteAmount
            }

      // Get the estimate from the server:
      const quoteReplies = await Promise.all([
        call({
          jsonrpc: '2.0',
          id: 'one',
          method: 'getMinAmount',
          params: {
            from: safeFromCurrencyCode,
            to: safeToCurrencyCode
          }
        }),
        call({
          jsonrpc: '2.0',
          id: 'two',
          method: 'getExchangeAmount',
          params: quoteParams
        })
      ])
      checkReply(quoteReplies[0], request)

      // Check the minimum:
      const nativeMin = await request.fromWallet.denominationToNative(
        quoteReplies[0].result,
        request.fromCurrencyCode
      )
      if (lt(request.nativeAmount, nativeMin)) {
        throw new SwapBelowLimitError(swapInfo, nativeMin)
      }

      checkReply(quoteReplies[1], request)

      // Calculate the amounts:
      let fromAmount, fromNativeAmount, toNativeAmount
      if (request.quoteFor === 'from') {
        fromAmount = quoteAmount
        fromNativeAmount = request.nativeAmount
        toNativeAmount = await request.toWallet.denominationToNative(
          quoteReplies[1].result,
          request.toCurrencyCode
        )
      } else {
        fromAmount = mul(quoteReplies[1].result, '1.02')
        fromNativeAmount = await request.fromWallet.denominationToNative(
          fromAmount,
          request.fromCurrencyCode
        )
        toNativeAmount = request.nativeAmount
      }

      // Get the address:
      const sendReply = await call({
        jsonrpc: '2.0',
        id: 3,
        method: 'createTransaction',
        params: {
          amount: fromAmount,
          from: safeFromCurrencyCode,
          to: safeToCurrencyCode,
          address: toAddress,
          extraId: null,
          refundAddress: fromAddress,
          refundExtraId: null
        }
      })
      checkReply(sendReply, request)
      const quoteInfo: QuoteInfo = sendReply.result
      // Make the transaction:
      const spendInfo: EdgeSpendInfo = {
        currencyCode: request.fromCurrencyCode,
        spendTargets: [
          {
            nativeAmount: fromNativeAmount,
            publicAddress: quoteInfo.payinAddress,
            uniqueIdentifier: quoteInfo.payinExtraId || undefined
          }
        ],
        swapData: {
          orderId: quoteInfo.id,
          isEstimate: true,
          payoutAddress: toAddress,
          payoutCurrencyCode: request.toCurrencyCode,
          payoutNativeAmount: toNativeAmount,
          payoutWalletId: request.toWallet.id,
          plugin: { ...swapInfo },
          refundAddress: fromAddress
        }
      }
      log('spendInfo', spendInfo)
      const tx: EdgeTransaction = await request.fromWallet.makeSpend(spendInfo)

      return makeSwapPluginQuote(
        request,
        fromNativeAmount,
        toNativeAmount,
        tx,
        toAddress,
        'changehero',
        true,
        new Date(Date.now() + expirationMs),
        quoteInfo.id
      )
    }
  }

  return out
}
