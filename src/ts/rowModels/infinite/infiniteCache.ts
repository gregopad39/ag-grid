import {Utils as _} from "../../utils";
import {RowNode} from "../../entities/rowNode";
import {Autowired, Context, PostConstruct, Qualifier} from "../../context/context";
import {EventService} from "../../eventService";
import {Events} from "../../events";
import {Logger, LoggerFactory} from "../../logger";
import {IDatasource} from "../iDatasource";
import {InfiniteBlock} from "./infiniteBlock";
import {RowNodeCache, RowNodeCacheParams} from "../cache/rowNodeCache";

export interface InfiniteCacheParams extends RowNodeCacheParams {
    datasource: IDatasource;
}

export class InfiniteCache extends RowNodeCache<InfiniteBlock, InfiniteCacheParams> {

    @Autowired('eventService') private eventService: EventService;
    @Autowired('context') private context: Context;

    constructor(params: InfiniteCacheParams) {
        super(params);
    }

    private setBeans(@Qualifier('loggerFactory') loggerFactory: LoggerFactory) {
        this.logger = loggerFactory.create('VirtualPageCache');
    }

    @PostConstruct
    private init(): void {
        // start load of data, as the virtualRowCount will remain at 0 otherwise,
        // so we need this to kick things off, otherwise grid would never call getRow()
        this.getRow(0);
    }

    private moveItemsDown(page: InfiniteBlock, moveFromIndex: number, moveCount: number): void {
        let startRow = page.getStartRow();
        let endRow = page.getEndRow();
        let indexOfLastRowToMove = moveFromIndex + moveCount;

        // all rows need to be moved down below the insertion index
        for (let currentRowIndex = endRow - 1; currentRowIndex >= startRow; currentRowIndex--) {
            // don't move rows at or before the insertion index
            if (currentRowIndex < indexOfLastRowToMove) {
                continue;
            }

            let indexOfNodeWeWant = currentRowIndex - moveCount;
            let nodeForThisIndex = this.getRow(indexOfNodeWeWant, true);

            if (nodeForThisIndex) {
                page.setRowNode(currentRowIndex, nodeForThisIndex);
            } else {
                page.setBlankRowNode(currentRowIndex);
                page.setDirty();
            }
        }
    }

    private insertItems(block: InfiniteBlock, indexToInsert: number, items: any[]): RowNode[] {
        let pageStartRow = block.getStartRow();
        let pageEndRow = block.getEndRow();
        let newRowNodes: RowNode[] = [];

        // next stage is insert the rows into this page, if applicable
        for (let index = 0; index < items.length; index++) {
            let rowIndex = indexToInsert + index;

            let currentRowInThisPage = rowIndex >= pageStartRow && rowIndex < pageEndRow;

            if (currentRowInThisPage) {
                let dataItem = items[index];
                let newRowNode = block.setNewData(rowIndex, dataItem);
                newRowNodes.push(newRowNode);
            }
        }

        return newRowNodes;
    }

    public insertItemsAtIndex(indexToInsert: number, items: any[]): void {
        // get all page id's as NUMBERS (not strings, as we need to sort as numbers) and in descending order

        let newNodes: RowNode[] = [];
        this.forEachBlockInReverseOrder( (block: InfiniteBlock) => {
            let pageEndRow = block.getEndRow();

            // if the insertion is after this page, then this page is not impacted
            if (pageEndRow <= indexToInsert) {
                return;
            }

            this.moveItemsDown(block, indexToInsert, items.length);
            let newNodesThisPage = this.insertItems(block, indexToInsert, items);
            newNodesThisPage.forEach(rowNode => newNodes.push(rowNode));
        });

        if (this.isMaxRowFound()) {
            this.hack_setVirtualRowCount(this.getVirtualRowCount() + items.length);
        }

        this.dispatchModelUpdated();
        this.eventService.dispatchEvent(Events.EVENT_ITEMS_ADDED, newNodes);
    }

    // the rowRenderer will not pass dontCreatePage, meaning when rendering the grid,
    // it will want new pages in the cache as it asks for rows. only when we are inserting /
    // removing rows via the api is dontCreatePage set, where we move rows between the pages.
    public getRow(rowIndex: number, dontCreatePage = false): RowNode {
        let blockId = Math.floor(rowIndex / this.cacheParams.pageSize);
        let block = this.getBlock(blockId);

        if (!block) {
            if (dontCreatePage) {
                return null;
            } else {
                block = this.createBlock(blockId);
            }
        }

        return block.getRow(rowIndex);
    }

    private createBlock(blockNumber: number): InfiniteBlock {

        let newBlock = new InfiniteBlock(blockNumber, this.cacheParams);
        this.context.wireBean(newBlock);

        newBlock.addEventListener(InfiniteBlock.EVENT_LOAD_COMPLETE, this.onPageLoaded.bind(this));

        this.setBlock(blockNumber, newBlock);

        let needToPurge = _.exists(this.cacheParams.maxBlocksInCache)
            && this.getBlockCount() > this.cacheParams.maxBlocksInCache;
        if (needToPurge) {
            let lruPage = this.findLeastRecentlyUsedPage(newBlock);
            this.removeBlockFromCache(lruPage);
        }

        this.checkBlockToLoad();

        return newBlock;
    }

    private removeBlockFromCache(pageToRemove: InfiniteBlock): void {
        if (!pageToRemove) {
            return;
        }

        this.removeBlock(pageToRemove.getPageNumber());

        // we do not want to remove the 'loaded' event listener, as the
        // concurrent loads count needs to be updated when the load is complete
        // if the purged page is in loading state
    }

    private findLeastRecentlyUsedPage(pageToExclude: InfiniteBlock): InfiniteBlock {

        let lruPage: InfiniteBlock = null;

        this.forEachBlockInOrder( (block: InfiniteBlock)=> {
            // we exclude checking for the page just created, as this has yet to be accessed and hence
            // the lastAccessed stamp will not be updated for the first time yet
            if (block === pageToExclude) {
                return;
            }

            if (_.missing(lruPage) || block.getLastAccessed() < lruPage.getLastAccessed()) {
                lruPage = block;
            }
        });

        return lruPage;
    }

    protected dispatchModelUpdated(): void {
        if (this.isActive()) {
            this.eventService.dispatchEvent(Events.EVENT_MODEL_UPDATED);
        }
    }

    public refreshCache(): void {
        this.forEachBlockInOrder( block => block.setDirty() );
        this.checkBlockToLoad();
    }

    public purgeCache(): void {
        this.forEachBlockInOrder( block => this.removeBlockFromCache(block));
        this.dispatchModelUpdated();
    }

}