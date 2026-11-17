import {HttpError,sha} from './core.mjs';
import {EDITABLE_REPLY_STYLES,replyEditContextRevision} from './reply-edit.mjs';
import {replyLanguageSource,replySourceRevision} from './reply-language.mjs';
import {TRANSLATION_LANGUAGES} from './qwen.mjs';

export const replySendChoice=body=>sha(JSON.stringify([body.style,body.source_edit_id??null,body.translation_id??null,body.language??'auto']));
export function prepareReplySend(analysis,body,context,referenceRevision){
  if(!EDITABLE_REPLY_STYLES.includes(body.style))throw new HttpError(400,'请选择有效的推荐回复。');
  if(analysis.stale||analysis.references_stale)throw new HttpError(409,'消息、回复或资料已有更新，请重新分析后再使用回复。');
  const editId=body.source_edit_id??null,source=replyLanguageSource(analysis,body.style,editId);
  if(!source)throw new HttpError(409,'所选回复版本已经失效，请刷新后重试。');
  let selected=source;
  if(body.translation_id){
    if(!Object.hasOwn(TRANSLATION_LANGUAGES,body.language))throw new HttpError(400,'请选择有效的回复语言。');
    const translation=analysis.reply_translations?.[body.style]?.[body.language];
    if(!translation||translation.id!==body.translation_id||translation.stale||(translation.source_edit_id??null)!==editId||translation.source_revision!==replySourceRevision(source,editId))throw new HttpError(409,'所选翻译已经失效，请重新翻译后再使用。');
    selected=translation;
  }else if(body.language&&body.language!=='auto')throw new HttpError(400,'回复语言与所选版本不一致。');
  const snapshot={text:selected.text,chinese:selected.chinese,language:selected.language,style:body.style,source_edit_id:editId,translation_id:body.translation_id??null};
  const revision=sha(JSON.stringify([analysis.id,snapshot,replySourceRevision(source,editId),replyEditContextRevision(context),referenceRevision]));
  return {snapshot,revision};
}
